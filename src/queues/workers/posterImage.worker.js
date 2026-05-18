const { Worker } = require("bullmq");
const { getConnection } = require("../connection");
const { QUEUE_NAMES } = require("../queues");
const logger = require("../../core/logger");
const Business = require("../../modules/business/business.model");
const Content = require("../../modules/content/content.model");
const ContentPlan = require("../../modules/poster/contentPlan.model");
const Usage = require("../../modules/usage/usage.model");
const posterService = require("../../services/poster.service");

/**
 * Poster Image Worker
 * Generates the actual poster image via gpt-image-2, saves locally, creates Content record.
 * Concurrency is limited to 3 since image generation is slow + expensive.
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

      // Mark as generating
      await ContentPlan.updateOne(
        { _id: contentPlanId, "days.dayNumber": dayNumber },
        { $set: { "days.$.imageStatus": "generating" } }
      );

      try {
        // Read model image if configured
        let modelImageBuffer = null;
        if (business.posterSettings?.useModelImage && business.posterSettings?.modelImagePath) {
          modelImageBuffer = await posterService.readModelImageBuffer(
            business.posterSettings.modelImagePath
          );
        }

        const sizeKey = business.posterSettings?.defaultSize || "4:5";
        const quality = business.posterSettings?.defaultQuality || "auto";

        // Generate the poster image
        const imageResult = await posterService.generatePosterImage(
          day.prompt,
          {
            headline: day.promptText?.headline || "",
            tagline: day.promptText?.tagline || "",
            offer: day.promptText?.offer || "",
            cta: day.promptText?.cta || "",
          },
          business,
          { size: sizeKey, quality, modelImageBuffer }
        );

        // Save locally
        const dateStr = new Date(day.date).toISOString().split("T")[0];
        const { localPath, publicUrl } = await posterService.savePosterLocally(
          imageResult.imageBuffer,
          plan.businessId,
          `${dateStr}_day${dayNumber}`
        );

        // Create Content record
        const content = await Content.create({
          userId: plan.userId,
          businessId: plan.businessId,
          imageUrl: publicUrl,
          caption: `${day.promptText?.headline || day.topic} — ${business.businessName}`,
          status: "ready",
          sourceType: "ai-poster",
          tags: [day.contentType, "auto-generated"],
          localImagePath: localPath,
          generationCost: {
            imageCost: imageResult.imageCost,
            totalCost: imageResult.imageCost,
            imageSize: imageResult.apiSize,
            imageQuality: imageResult.quality,
          },
        });

        // Update ContentPlan day
        await ContentPlan.updateOne(
          { _id: contentPlanId, "days.dayNumber": dayNumber },
          {
            $set: {
              "days.$.imageStatus": "ready",
              "days.$.localImagePath": localPath,
              "days.$.contentId": content._id,
              "days.$.imageGeneratedAt": new Date(),
              "days.$.lastError": "",
            },
            $max: { imagesGeneratedUpTo: dayNumber },
          }
        );

        // Increment usage counter
        const dateKey = new Date().toISOString().split("T")[0];
        await Usage.updateOne(
          { userId: plan.userId, dateKey },
          { $inc: { aiPostersCount: 1 } },
          { upsert: true }
        );

        logger.info("[posterImage.worker] done", {
          contentPlanId,
          dayNumber,
          contentId: content._id.toString(),
          cost: imageResult.imageCost,
        });

        return {
          contentId: content._id.toString(),
          localPath,
          imageCost: imageResult.imageCost,
        };
      } catch (err) {
        await ContentPlan.updateOne(
          { _id: contentPlanId, "days.dayNumber": dayNumber },
          {
            $set: {
              "days.$.imageStatus": "failed",
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

module.exports = { start };
