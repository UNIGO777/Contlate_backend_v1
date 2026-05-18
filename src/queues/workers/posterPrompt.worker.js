const { Worker } = require("bullmq");
const { getConnection } = require("../connection");
const { QUEUE_NAMES, getQueues } = require("../queues");
const logger = require("../../core/logger");
const Business = require("../../modules/business/business.model");
const ContentPlan = require("../../modules/poster/contentPlan.model");
const posterService = require("../../services/poster.service");

/**
 * Poster Prompt Worker
 * Generates a GPT poster prompt for a specific day in a content plan.
 * After prompt is ready, queues image generation if this is tomorrow's (or today's) poster.
 */
const start = () => {
  const worker = new Worker(
    QUEUE_NAMES.POSTER_PROMPT,
    async (job) => {
      const { contentPlanId, dayNumber } = job.data;
      logger.info("[posterPrompt.worker] starting", { contentPlanId, dayNumber, jobId: job.id });

      const plan = await ContentPlan.findById(contentPlanId);
      if (!plan) throw new Error(`ContentPlan not found: ${contentPlanId}`);

      const day = plan.days.find((d) => d.dayNumber === dayNumber);
      if (!day) throw new Error(`Day ${dayNumber} not found in plan ${contentPlanId}`);
      if (day.promptStatus === "ready" || day.promptStatus === "edited") {
        logger.info("[posterPrompt.worker] prompt already ready, skipping", { contentPlanId, dayNumber });
        return { skipped: true };
      }

      const business = await Business.findById(plan.businessId);
      if (!business) throw new Error(`Business not found: ${plan.businessId}`);

      // Mark as generating
      await ContentPlan.updateOne(
        { _id: contentPlanId, "days.dayNumber": dayNumber },
        { $set: { "days.$.promptStatus": "generating" } }
      );

      try {
        const result = await posterService.generatePosterPrompt(business, {
          topic: day.topic,
          description: day.description,
          contentType: day.contentType,
        });

        // Update the day with generated prompt
        await ContentPlan.updateOne(
          { _id: contentPlanId, "days.dayNumber": dayNumber },
          {
            $set: {
              "days.$.promptStatus": "ready",
              "days.$.prompt": result.fullPrompt,
              "days.$.promptText.headline": result.headline,
              "days.$.promptText.tagline": result.tagline,
              "days.$.promptText.offer": result.offer,
              "days.$.promptText.cta": result.cta,
              "days.$.promptGeneratedAt": new Date(),
              "days.$.lastError": "",
            },
            $max: { promptsGeneratedUpTo: dayNumber },
          }
        );

        // If this is day 1 or tomorrow's poster, queue image generation
        const now = new Date();
        const dayDate = new Date(day.date);
        const diffMs = dayDate.getTime() - now.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);

        // Queue image if poster date is within next 36 hours
        if (diffHours <= 36) {
          const queues = getQueues();
          await queues.posterImage.add(
            `image-day-${dayNumber}-${plan.businessId}`,
            { contentPlanId: contentPlanId.toString(), dayNumber },
            { delay: 1000 }
          );
        }

        logger.info("[posterPrompt.worker] done", { contentPlanId, dayNumber });
        return { success: true, gptCost: result.gptCost };
      } catch (err) {
        await ContentPlan.updateOne(
          { _id: contentPlanId, "days.dayNumber": dayNumber },
          {
            $set: {
              "days.$.promptStatus": "failed",
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

module.exports = { start };
