const { Worker } = require("bullmq");
const { getConnection } = require("../connection");
const { QUEUE_NAMES, getQueues } = require("../queues");
const logger = require("../../core/logger");
const Business = require("../../modules/business/business.model");
const Content = require("../../modules/content/content.model");
const ContentPlan = require("../../modules/poster/contentPlan.model");
const Usage = require("../../modules/usage/usage.model");
const posterService = require("../../services/poster.service");
const { sendAppNotification } = require("../../utils/notifications");

/**
 * Poster Image Worker
 *
 * Generates the poster image via gpt-image-2, uploads to Cloudinary, creates
 * a Content record, and advances the Phase 5 chain to the next day.
 *
 * planStatus transitions:
 *   in_queue → generating  (job picked up by worker)
 *   generating → ready     (image generated OK)
 *   generating → in_queue  (failed — queueToken cleared, retried by BullMQ)
 *
 * After success:
 *   → Queue Day N+1 prompt immediately (chain continues)
 *   → Emit socket event so frontend updates in real-time
 */
const start = () => {
  const worker = new Worker(
    QUEUE_NAMES.POSTER_IMAGE,
    async (job) => {
      const { contentPlanId, dayNumber } = job.data;
      logger.info("[posterImage.worker] starting", { contentPlanId, dayNumber, jobId: job.id });

      const plan = await ContentPlan.findById(contentPlanId);
      if (!plan) throw new Error(`ContentPlan not found: ${contentPlanId}`);

      const day = plan.days.find((d) => d.dayNumber === dayNumber);
      if (!day) throw new Error(`Day ${dayNumber} not found in plan ${contentPlanId}`);

      if (day.imageStatus === "ready") {
        logger.info("[posterImage.worker] image already ready, skipping", { contentPlanId, dayNumber });
        return { skipped: true };
      }

      if (day.promptStatus !== "ready" && day.promptStatus !== "edited") {
        throw new Error(`Prompt not ready for day ${dayNumber} (status: ${day.promptStatus})`);
      }

      const business = await Business.findById(plan.businessId);
      if (!business) throw new Error(`Business not found: ${plan.businessId}`);

      // ── Mark as generating ──────────────────────────────────────────────
      await ContentPlan.updateOne(
        { _id: contentPlanId, "days.dayNumber": dayNumber },
        {
          $set: {
            "days.$.imageStatus": "generating",
            "days.$.planStatus": "generating",
            "days.$.queueToken": null, // clear token — no longer queued
          },
        }
      );

      try {
        // ── Read model image if configured ─────────────────────────────
        let modelImageBuffer = null;
        if (business.posterSettings?.useModelImage && business.posterSettings?.modelImagePath) {
          modelImageBuffer = await posterService.readModelImageBuffer(
            business.posterSettings.modelImagePath
          );
        }

        const sizeKey = business.posterSettings?.defaultSize || "4:5";
        const quality  = business.posterSettings?.defaultQuality || "auto";

        // ── Generate poster image ───────────────────────────────────────
        const imageResult = await posterService.generatePosterImage(
          day.prompt,
          {
            headline: day.promptText?.headline || "",
            tagline:  day.promptText?.tagline  || "",
            offer:    day.promptText?.offer    || "",
            cta:      day.promptText?.cta      || "",
          },
          business,
          { size: sizeKey, quality, modelImageBuffer }
        );

        // ── Save locally and derive public URL ─────────────────────────
        const dateStr = new Date(day.date).toISOString().split("T")[0];
        const { localPath, publicUrl } = await posterService.savePosterLocally(
          imageResult.imageBuffer,
          plan.businessId,
          `${dateStr}_day${dayNumber}`
        );

        // ── Caption: prefer AI-generated, fall back to headline ─────────
        const caption =
          day.caption && day.caption.trim()
            ? day.caption
            : `${day.promptText?.headline || day.title || day.topic} — ${business.businessName}`;

        // ── Create Content record ───────────────────────────────────────
        const content = await Content.create({
          userId: plan.userId,
          businessId: plan.businessId,
          imageUrl: publicUrl,
          caption,
          status: "ready",
          sourceType: "ai-poster",
          tags: [day.contentType || "auto", "auto-generated"].filter(Boolean),
          localImagePath: localPath,
          generationCost: {
            imageCost: imageResult.imageCost,
            totalCost: imageResult.imageCost,
            imageSize: imageResult.apiSize,
            imageQuality: imageResult.quality,
          },
        });

        // ── Update ContentPlan day — planStatus: ready ─────────────────
        await ContentPlan.updateOne(
          { _id: contentPlanId, "days.dayNumber": dayNumber },
          {
            $set: {
              "days.$.imageStatus": "ready",
              "days.$.planStatus": "ready",
              "days.$.imageUrl": publicUrl,        // public URL for frontend
              "days.$.localImagePath": localPath,
              "days.$.caption": caption,
              "days.$.contentId": content._id,
              "days.$.imageGeneratedAt": new Date(),
              "days.$.lastError": "",
            },
            $max: { imagesGeneratedUpTo: dayNumber },
          }
        );

        // ── Increment usage ─────────────────────────────────────────────
        const dateKey = new Date().toISOString().split("T")[0];
        await Usage.updateOne(
          { userId: plan.userId, dateKey },
          { $inc: { aiPostersCount: 1 } },
          { upsert: true }
        );

        // ── Chain: queue next day's prompt immediately ──────────────────
        await _chainNextDay(plan, dayNumber, contentPlanId);

        // ── Notify user: poster is ready to review ──────────────────────
        sendAppNotification(plan.userId, "POSTER_READY", { dayNumber });

        // ── Notify frontend via socket ──────────────────────────────────
        _emitPosterReady(plan.businessId, dayNumber, publicUrl, caption, content._id);

        logger.info("[posterImage.worker] done", {
          contentPlanId,
          dayNumber,
          contentId: content._id.toString(),
          cost: imageResult.imageCost,
        });

        return {
          contentId: content._id.toString(),
          localPath,
          publicUrl,
          imageCost: imageResult.imageCost,
        };
      } catch (err) {
        await ContentPlan.updateOne(
          { _id: contentPlanId, "days.dayNumber": dayNumber },
          {
            $set: {
              "days.$.imageStatus": "failed",
              "days.$.planStatus": "in_queue",  // revert so scheduler re-queues
              "days.$.lastError": err.message.slice(0, 500),
            },
            $inc: { "days.$.retryCount": 1 },
          }
        );
        throw err;
      }
    },
    {
      connection: getConnection(),
      concurrency: 3,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error("[posterImage.worker] failed", {
      jobId: job?.id,
      data: job?.data,
      error: err.message,
    });
  });

  return worker;
};

/**
 * After Day N image is done, immediately queue Day N+1 prompt.
 * This drives the Phase 5 daily chain for premium users.
 */
async function _chainNextDay(plan, completedDayNumber, contentPlanId) {
  const nextDayNumber = completedDayNumber + 1;
  if (nextDayNumber > 28) return; // chain complete

  const nextDay = plan.days.find((d) => d.dayNumber === nextDayNumber);
  if (!nextDay) return;

  // Only chain if prompt hasn't been started yet
  if (nextDay.promptStatus !== "pending") {
    logger.info("[posterImage.worker] next day prompt already started, skipping chain", {
      contentPlanId: String(contentPlanId),
      nextDayNumber,
    });
    return;
  }

  const queues = getQueues();

  // Mark next day as generating before queuing (optimistic)
  await ContentPlan.updateOne(
    { _id: contentPlanId, "days.dayNumber": nextDayNumber },
    { $set: { "days.$.promptStatus": "generating", "days.$.planStatus": "generating" } }
  );

  await queues.posterPrompt.add(
    `chain-prompt-day-${nextDayNumber}-${plan.businessId}`,
    { contentPlanId: String(contentPlanId), dayNumber: nextDayNumber },
    { jobId: `prompt-${plan._id}-day${nextDayNumber}` } // dedup key
  );

  logger.info("[posterImage.worker] chained next prompt", {
    contentPlanId: String(contentPlanId),
    nextDayNumber,
  });
}

/**
 * Emit real-time socket event so the frontend updates the day circle and modal.
 */
function _emitPosterReady(businessId, dayNumber, imageUrl, caption, contentId) {
  try {
    const { getIO } = require("../../core/socket");
    const io = getIO();
    if (!io) return;

    io.to(`business:${businessId}`).emit("plan:poster-ready", {
      businessId: String(businessId),
      dayNumber,
      imageUrl,
      caption,
      contentId: String(contentId),
      planStatus: "ready",
    });
  } catch (err) {
    logger.warn("[posterImage.worker] socket emit failed", { error: err.message });
  }
}

module.exports = { start };
