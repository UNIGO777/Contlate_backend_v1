const { Worker } = require("bullmq");
const { getConnection } = require("../connection");
const { QUEUE_NAMES, getQueues } = require("../queues");
const logger = require("../../core/logger");
const Business = require("../../modules/business/business.model");
const ContentPlan = require("../../modules/poster/contentPlan.model");
const posterService = require("../../services/poster.service");

/**
 * Poster Prompt Worker
 *
 * Generates a GPT prompt for a specific day in a ContentPlan.
 *
 * Phase 5 chain (premium):
 *   plan created → queue Day 1 prompt (immediate)
 *   Day N prompt done → queue Day N image (delayed until scheduledGenerationAt)
 *   Day N image done → queue Day N+1 prompt (immediate) [handled in posterImage.worker]
 *
 * planStatus transitions this worker drives:
 *   concept → generating  (prompt job picked up)
 *   generating → prompt_ready  (prompt generated OK)
 *   generating → concept  (prompt failed — revert so scheduler can retry)
 *
 * When image job is queued after prompt:
 *   prompt_ready → in_queue  (image entered Bull queue, queueToken assigned)
 */
const start = () => {
  const worker = new Worker(
    QUEUE_NAMES.POSTER_PROMPT,
    async (job) => {
      const { contentPlanId, dayNumber } = job.data;
      logger.info("[posterPrompt.worker] starting", { contentPlanId, dayNumber, jobId: job.id });

      // Reload fresh so we have scheduledGenerationAt + planStatus
      const plan = await ContentPlan.findById(contentPlanId);
      if (!plan) throw new Error(`ContentPlan not found: ${contentPlanId}`);

      const day = plan.days.find((d) => d.dayNumber === dayNumber);
      if (!day) throw new Error(`Day ${dayNumber} not found in plan ${contentPlanId}`);

      // Idempotency — skip if already past prompt stage
      if (day.promptStatus === "ready" || day.promptStatus === "edited") {
        logger.info("[posterPrompt.worker] prompt already ready, skipping", { contentPlanId, dayNumber });
        return { skipped: true };
      }

      const business = await Business.findById(plan.businessId);
      if (!business) throw new Error(`Business not found: ${plan.businessId}`);

      // ── Mark as generating ──────────────────────────────────────────────
      await ContentPlan.updateOne(
        { _id: contentPlanId, "days.dayNumber": dayNumber },
        { $set: { "days.$.promptStatus": "generating", "days.$.planStatus": "generating" } }
      );

      try {
        const result = await posterService.generatePosterPrompt(business, {
          topic: day.topic || day.title,
          description: day.description,
          contentType: day.contentType,
        });

        // ── Persist prompt + caption + planStatus ───────────────────────
        await ContentPlan.updateOne(
          { _id: contentPlanId, "days.dayNumber": dayNumber },
          {
            $set: {
              "days.$.promptStatus": "ready",
              "days.$.planStatus": "prompt_ready",
              "days.$.prompt": result.fullPrompt,
              "days.$.promptText.headline": result.headline,
              "days.$.promptText.tagline": result.tagline,
              "days.$.promptText.offer": result.offer,
              "days.$.promptText.cta": result.cta,
              "days.$.promptGeneratedAt": new Date(),
              "days.$.caption": result.caption || "",
              "days.$.lastError": "",
            },
            $max: { promptsGeneratedUpTo: dayNumber },
          }
        );

        // ── Queue image generation ──────────────────────────────────────
        await _queueImageJob(plan, day, dayNumber, contentPlanId);

        logger.info("[posterPrompt.worker] done", { contentPlanId, dayNumber });
        return { success: true };
      } catch (err) {
        // Revert planStatus so scheduler can retry
        await ContentPlan.updateOne(
          { _id: contentPlanId, "days.dayNumber": dayNumber },
          {
            $set: {
              "days.$.promptStatus": "failed",
              "days.$.planStatus": "concept",
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
      concurrency: 10,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error("[posterPrompt.worker] failed", {
      jobId: job?.id,
      data: job?.data,
      error: err.message,
    });
  });

  return worker;
};

/**
 * Queue the image generation job for dayNumber, delayed until scheduledGenerationAt.
 * Updates planStatus → 'in_queue' and writes the queueToken on the day.
 */
async function _queueImageJob(plan, day, dayNumber, contentPlanId) {
  const queues = getQueues();

  // Delay until scheduledGenerationAt; run immediately if already past
  const generationAt = day.scheduledGenerationAt ? new Date(day.scheduledGenerationAt) : new Date();
  const delayMs = Math.max(0, generationAt.getTime() - Date.now());

  // Approximate position = current waiting count + 1
  const waitingCount = await queues.posterImage.getJobCountByTypes("waiting", "delayed");
  const queueToken = waitingCount + 1;

  await queues.posterImage.add(
    `image-day-${dayNumber}-${plan.businessId}`,
    { contentPlanId: String(contentPlanId), dayNumber },
    { delay: delayMs, jobId: `image-${plan._id}-day${dayNumber}` } // dedup key
  );

  // Transition to in_queue
  await ContentPlan.updateOne(
    { _id: contentPlanId, "days.dayNumber": dayNumber },
    {
      $set: {
        "days.$.planStatus": "in_queue",
        "days.$.queueToken": queueToken,
      },
    }
  );

  logger.info("[posterPrompt.worker] image job queued", {
    contentPlanId: String(contentPlanId),
    dayNumber,
    delayMs,
    queueToken,
  });
}

module.exports = { start, _queueImageJob };
