const { Worker } = require("bullmq");
const { getConnection } = require("../connection");
const { QUEUE_NAMES, getQueues } = require("../queues");
const logger = require("../../core/logger");
const Business = require("../../modules/business/business.model");
const ContentPlan = require("../../modules/poster/contentPlan.model");
const posterService = require("../../services/poster.service");

/**
 * Content Plan Worker
 * Generates a 28-day content calendar for a premium business.
 * After plan creation, queues prompts for first 3 days and image for day 1.
 */
const start = () => {
  const worker = new Worker(
    QUEUE_NAMES.CONTENT_PLAN,
    async (job) => {
      const { businessId, userId, cycleStartDate } = job.data;
      logger.info("[contentPlan.worker] starting", { businessId, jobId: job.id });

      const business = await Business.findOne({ _id: businessId, userId });
      if (!business) throw new Error(`Business not found: ${businessId}`);

      // Generate 28-day plan via GPT
      const { days, inputTokens, outputTokens } = await posterService.generateMonthlyPlan(business);

      // Build day documents with actual dates
      const start = new Date(cycleStartDate);
      const dayDocs = days.map((d, i) => {
        const date = new Date(start);
        date.setDate(date.getDate() + i);
        return {
          dayNumber: d.dayNumber,
          date,
          topic: d.topic,
          description: d.description,
          contentType: d.contentType,
          promptStatus: "pending",
          imageStatus: "pending",
        };
      });

      // Create ContentPlan document
      const endDate = new Date(start);
      endDate.setDate(endDate.getDate() + 27);

      const plan = await ContentPlan.create({
        userId,
        businessId,
        planType: "premium",
        cycleStartDate: start,
        cycleEndDate: endDate,
        status: "active",
        days: dayDocs,
      });

      // Update business with active plan reference
      await Business.updateOne(
        { _id: businessId },
        { activeContentPlanId: plan._id }
      );

      // Queue prompts for first 3 days
      const queues = getQueues();
      const promptJobs = [];
      for (let i = 1; i <= Math.min(3, dayDocs.length); i++) {
        promptJobs.push({
          name: `prompt-day-${i}-${businessId}`,
          data: { contentPlanId: plan._id.toString(), dayNumber: i },
          opts: { delay: (i - 1) * 2000 }, // stagger slightly
        });
      }
      if (promptJobs.length) {
        await queues.posterPrompt.addBulk(promptJobs);
      }

      logger.info("[contentPlan.worker] done", {
        businessId,
        planId: plan._id.toString(),
        daysCreated: dayDocs.length,
      });

      return { planId: plan._id.toString(), daysCreated: dayDocs.length };
    },
    {
      connection: getConnection(),
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error("[contentPlan.worker] failed", {
      jobId: job?.id,
      data: job?.data,
      error: err.message,
    });
  });

  return worker;
};

module.exports = { start };
