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

      // Archive a thumbnail, then delete the full-size file.
      //
      // Deleting without this left content.imageUrl pointing at a file that
      // no longer existed, so every published poster 404'd in the app a day
      // after it went out. Instagram's CDN copy was the fallback, but those
      // URLs are signed and expire, so published posts ended up with no
      // image at all.
      if (content.localImagePath && !content.localImageDeleted) {
        try {
          const thumb = await posterService.archivePosterThumbnail(
            content.localImagePath,
            content.businessId
          );
          if (thumb) {
            content.thumbnailUrl = thumb.publicUrl;
            content.thumbnailPath = thumb.localPath;
            // Point the app at something that will still be there tomorrow.
            content.imageUrl = thumb.publicUrl;
          }
        } catch (err) {
          // A failed thumbnail must not cost us the disk saving, but it must
          // also not silently destroy the only visible copy — so the original
          // is kept and cleanup retries on the next pass.
          logger.warn("[posterCleanup.worker] thumbnail failed, keeping original", {
            contentId,
            message: err.message,
          });
          return { cleaned: false, reason: "thumbnail_failed" };
        }

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
              // The plan day renders from its own copy of the url, so it has
              // to follow the content to the thumbnail or it keeps 404ing.
              ...(content.thumbnailUrl ? { "days.$.imageUrl": content.thumbnailUrl } : {}),
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
