const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const { CONTENT_STATUS } = require("../../constants/contentStatus");
const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");
const { SCHEDULE_STATUS } = require("../../constants/scheduleStatus");
const { getLimits } = require("../../constants/publishingLimits");
const Content = require("../content/content.model");
const SocialAccount = require("../social/social.model");
const Schedule = require("../schedule/schedule.model");
const PublishLog = require("./publishLog.model");
const socialService = require("../../services/social.service");
const usageService = require("../usage/usage.service");
const logger = require("../../core/logger");

/**
 * Check the per-platform daily limit before an immediate publish.
 * Immediate publishes are counted against the same daily budget as scheduled ones.
 */
const assertImmediatePublishAllowed = async (socialAccountId, platform) => {
  const limits = getLimits(platform);
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  // Count today's successful publishes from PublishLog (covers both immediate + scheduled)
  const todayCount = await PublishLog.countDocuments({
    socialAccountId,
    status: "success",
    executedAt: { $gte: dayStart, $lt: dayEnd },
  });

  if (todayCount >= limits.maxPerDay) {
    throw new ApiError(429, `Daily posting limit (${limits.maxPerDay} posts/day) reached for this account.`, {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }

  // Minimum interval: no successful publish in the last N minutes
  const gapMs = limits.minIntervalMinutes * 60 * 1000;
  const recentPublish = await PublishLog.findOne({
    socialAccountId,
    status: "success",
    executedAt: { $gte: new Date(now.getTime() - gapMs) },
  }).lean();

  if (recentPublish) {
    throw new ApiError(400, `Posts to the same account must be at least ${limits.minIntervalMinutes} minutes apart.`, {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }
};

const sanitizeLog = (log) => ({
  id: log._id.toString(),
  scheduleId: log.scheduleId ? log.scheduleId.toString() : null,
  socialAccountId: log.socialAccountId.toString(),
  contentId: log.contentId.toString(),
  platform: log.platform,
  publishType: log.publishType,
  status: log.status,
  externalPostId: log.externalPostId,
  externalPostUrl: log.externalPostUrl,
  errorMessage: log.errorMessage,
  errorCode: log.errorCode,
  attempt: log.attempt,
  executedAt: log.executedAt,
  createdAt: log.createdAt,
});

/**
 * Publish content immediately to one or more social accounts.
 * Returns per-account results (partial success allowed).
 */
const publishNow = async (userId, businessId, { contentId, socialAccountIds }) => {
  if (!Array.isArray(socialAccountIds) || socialAccountIds.length === 0) {
    throw new ApiError(400, "Provide at least one social account.", {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }

  const content = await Content.findOne({ _id: contentId, userId });
  if (!content) {
    throw new ApiError(404, "Content not found.", { code: ERROR_CODES.NOT_FOUND });
  }
  if (content.status !== CONTENT_STATUS.READY) {
    throw new ApiError(400, "Content must be in ready status to publish.", {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }
  if (String(content.businessId) !== String(businessId)) {
    throw new ApiError(403, "Content does not belong to this business.", {
      code: ERROR_CODES.FORBIDDEN,
    });
  }

  const results = [];

  for (const accountId of socialAccountIds) {
    const account = await SocialAccount.findOne({ _id: accountId, userId });

    if (!account) {
      results.push({ accountId, status: "failed", error: "Account not found." });
      continue;
    }
    if (account.status !== SOCIAL_ACCOUNT_STATUS.CONNECTED) {
      results.push({ accountId, status: "failed", error: "Account is not connected." });
      continue;
    }
    if (String(account.businessId) !== String(businessId)) {
      results.push({ accountId, status: "failed", error: "Account does not belong to this business." });
      continue;
    }

    try {
      await assertImmediatePublishAllowed(account._id, account.platform);

      const result = await socialService.publishToSocial({ account, content });

      const postUrl = result.externalPostId
        ? `https://www.${account.platform}.com/${result.externalPostId}`
        : "";

      // Create PublishLog
      await PublishLog.create({
        scheduleId: null,
        socialAccountId: account._id,
        contentId: content._id,
        userId,
        businessId,
        platform: account.platform,
        publishType: "immediate",
        status: "success",
        externalPostId: result.externalPostId || "",
        externalPostUrl: postUrl,
        attempt: 1,
        executedAt: new Date(),
      });

      // Update content.socialPostUrls
      content.socialPostUrls.push({
        platform: account.platform,
        accountId: account.accountId,
        postId: result.externalPostId || "",
        postUrl,
        postedAt: new Date(),
      });

      results.push({
        accountId,
        platform: account.platform,
        accountName: account.accountName,
        status: "success",
        externalPostId: result.externalPostId || "",
        externalPostUrl: postUrl,
      });
    } catch (err) {
      logger.error("[publish.service] immediate publish failed", {
        accountId,
        contentId: content._id.toString(),
        message: err.message,
      });

      // Classify Meta token errors — prefer structured flag from graphFetch
      const errorCode = err.metaCode
        ? String(err.metaCode)
        : (err.message?.match(/\bcode[:\s]+(\d+)/i) || err.message?.match(/"code"\s*:\s*(\d+)/))?.[1] ?? "";

      await PublishLog.create({
        scheduleId: null,
        socialAccountId: account._id,
        contentId: content._id,
        userId,
        businessId,
        platform: account.platform,
        publishType: "immediate",
        status: "failed",
        errorMessage: err.message?.slice(0, 500) || "Unknown error",
        errorCode,
        attempt: 1,
        executedAt: new Date(),
      }).catch(() => {});

      // Mark account expired if token error
      if (errorCode === "190") {
        await SocialAccount.findByIdAndUpdate(account._id, {
          $set: { status: "expired", healthStatus: "critical", disconnectReason: "token_expired" },
        }).catch(() => {});
      }

      results.push({
        accountId,
        platform: account.platform,
        accountName: account.accountName,
        status: "failed",
        error: err.message?.slice(0, 200) || "Unknown error",
        errorCode,
        isRateLimit: !!err.isRateLimit,
        isAuthError: !!err.isAuthError,
      });
    }
  }

  // Save updated socialPostUrls if any succeeded
  const anySuccess = results.some((r) => r.status === "success");
  if (anySuccess) {
    if (content.status !== CONTENT_STATUS.PUBLISHED) {
      content.status = CONTENT_STATUS.PUBLISHED;
    }
    await content.save().catch(() => {});
    await usageService.incrementUsage(userId, "publishedPostsCount").catch(() => {});
  }

  return results;
};

/**
 * List publish logs for the user with pagination.
 */
const listLogs = async (userId, { page = 1, limit = 20, platform, status, publishType } = {}) => {
  const q = { userId };
  if (platform) q.platform = platform;
  if (status) q.status = status;
  if (publishType) q.publishType = publishType;

  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    PublishLog.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    PublishLog.countDocuments(q),
  ]);

  return { data: rows.map(sanitizeLog), page, limit, total };
};

/**
 * Get all publish logs for a specific schedule.
 */
const getLogsBySchedule = async (userId, scheduleId) => {
  // Verify schedule ownership
  const schedule = await Schedule.findOne({ _id: scheduleId, userId }).lean();
  if (!schedule) {
    throw new ApiError(404, "Schedule not found.", { code: ERROR_CODES.NOT_FOUND });
  }

  const logs = await PublishLog.find({ scheduleId, userId }).sort({ createdAt: -1 }).lean();
  return logs.map(sanitizeLog);
};

module.exports = { publishNow, listLogs, getLogsBySchedule };
