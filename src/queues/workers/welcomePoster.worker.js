const { Worker } = require("bullmq");
const { getConnection } = require("../connection");
const { QUEUE_NAMES } = require("../queues");
const logger = require("../../core/logger");
const Business = require("../../modules/business/business.model");
const Content = require("../../modules/content/content.model");
const posterService = require("../../services/poster.service");

/**
 * Welcome Poster Worker
 * Generates the 2 free welcome posters (intro + about-us) for new users.
 * These do NOT count against daily usage limits.
 */
const start = () => {
  const worker = new Worker(
    QUEUE_NAMES.WELCOME_POSTER,
    async (job) => {
      const { businessId, userId, posterType } = job.data; // posterType: "intro" | "about-us"
      logger.info("[welcomePoster.worker] starting", { businessId, posterType, jobId: job.id });

      const business = await Business.findById(businessId);
      if (!business) throw new Error(`Business not found: ${businessId}`);

      // Check if already done
      if (posterType === "intro" && business.welcomePosters?.introDone) {
        logger.info("[welcomePoster.worker] intro already done, skipping");
        return { skipped: true };
      }
      if (posterType === "about-us" && business.welcomePosters?.aboutUsDone) {
        logger.info("[welcomePoster.worker] about-us already done, skipping");
        return { skipped: true };
      }

      // Get welcome template
      const dayPlan = posterService.getWelcomeTemplate(posterType, business);

      // Generate prompt via GPT
      const promptResult = await posterService.generatePosterPrompt(business, dayPlan);

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
        promptResult.fullPrompt,
        {
          headline: promptResult.headline,
          tagline: promptResult.tagline,
          offer: promptResult.offer,
          cta: promptResult.cta,
        },
        business,
        { size: sizeKey, quality, modelImageBuffer }
      );

      // Save locally
      const { localPath, publicUrl } = await posterService.savePosterLocally(
        imageResult.imageBuffer,
        businessId,
        `welcome_${posterType}`
      );

      // Use AI-generated caption if available, else fallback
      const fallbackCaption =
        posterType === "intro"
          ? `Welcome to ${business.businessName}! We're here to serve you.`
          : `Learn more about ${business.businessName} — our story, our services, our commitment.`;

      // Create Content record
      const content = await Content.create({
        userId,
        businessId,
        imageUrl: publicUrl,
        caption: promptResult.caption || fallbackCaption,
        status: "ready",
        sourceType: "welcome-poster",
        tags: [posterType, "auto-generated", "welcome"],
        localImagePath: localPath,
        generationCost: {
          gptCost: promptResult.gptCost,
          imageCost: imageResult.imageCost,
          totalCost: promptResult.gptCost + imageResult.imageCost,
          inputTokens: promptResult.inputTokens,
          outputTokens: promptResult.outputTokens,
          imageSize: imageResult.apiSize,
          imageQuality: imageResult.quality,
        },
      });

      // Update business welcome status
      const updateField =
        posterType === "intro"
          ? { "welcomePosters.introDone": true, "welcomePosters.introContentId": content._id }
          : { "welcomePosters.aboutUsDone": true, "welcomePosters.aboutUsContentId": content._id };

      await Business.updateOne({ _id: businessId }, { $set: updateField });

      // Emit socket event so frontend shows congrats popup immediately
      try {
        const { getIO } = require("../../core/socket");
        const io = getIO();
        if (io) {
          io.to(`business:${businessId}`).emit("poster:ready", {
            businessId: businessId.toString(),
            posterType,
            contentId: content._id.toString(),
            imageUrl: publicUrl,
            caption: content.caption,
          });
        }
      } catch (socketErr) {
        logger.warn("[welcomePoster.worker] socket emit failed", { error: socketErr.message });
      }

      logger.info("[welcomePoster.worker] done", {
        businessId,
        posterType,
        contentId: content._id.toString(),
        totalCost: promptResult.gptCost + imageResult.imageCost,
      });

      return {
        contentId: content._id.toString(),
        posterType,
        totalCost: promptResult.gptCost + imageResult.imageCost,
      };
    },
    {
      connection: getConnection(),
      concurrency: 2,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error("[welcomePoster.worker] failed", {
      jobId: job?.id,
      data: job?.data,
      error: err.message,
    });
  });

  return worker;
};

module.exports = { start };
