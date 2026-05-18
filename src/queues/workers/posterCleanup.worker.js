const { Worker } = require("bullmq");
const { getConnection } = require("../connection");
const { QUEUE_NAMES } = require("../queues");
const logger = require("../../core/logger");
const Content = require("../../modules/content/content.model");
const ContentPlan = require("../../modules/poster/contentPlan.model");
const posterService = require("../../services/poster.service");

/**
 * Poster Cleanup Worker
 * After a poster is successfully posted to social media:
 * 1. Saves the social platform URLs to the Content record
 * 2. Deletes the local PNG file from disk
 * 3. Updates ContentPlan day as posted
 */
const start = () => {
  const worker = new Worker(
    QUEUE_NAMES.POSTER_CLEANUP,
    async (job) => {
      const { contentId, socialPostUrls } = job.data;
      logger.info("[posterCleanup.worker] starting", { contentId, jobId: job.id });

      const content = await Content.findById(contentId);
      if (!content) throw new Error(`Content not found: ${contentId}`);

      // Save social post URLs
      if (Array.isArray(socialPostUrls) && socialPostUrls.length) {
        content.socialPostUrls = socialPostUrls;
      }

      // Delete local file
      if (content.localImagePath && !content.localImageDeleted) {
        await posterService.deleteLocalPoster(content.localImagePath);
        content.localImageDeleted = true;
      }

      await content.save();

      // Update ContentPlan day if this content belongs to one
      if (content.sourceType === "ai-poster") {
        await ContentPlan.updateOne(
          { businessId: content.businessId, "days.contentId": content._id },
          {
            $set: {
              "days.$.posted": true,
              "days.$.postedAt": new Date(),
              "days.$.socialPostUrls": socialPostUrls || [],
            },
          }
        );
      }

      logger.info("[posterCleanup.worker] done", { contentId });
      return { cleaned: true };
    },
    {
      connection: getConnection(),
      concurrency: 10,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error("[posterCleanup.worker] failed", {
      jobId: job?.id,
      data: job?.data,
      error: err.message,
    });
  });

  return worker;
};

module.exports = { start };
