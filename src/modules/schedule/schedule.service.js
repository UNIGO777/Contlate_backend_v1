const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const { SCHEDULE_STATUS } = require("../../constants/scheduleStatus");
const { CONTENT_STATUS } = require("../../constants/contentStatus");
const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");
const { applyStagger } = require("../../utils/scheduleStagger");
const { getLimits } = require("../../constants/publishingLimits");
const Content = require("../content/content.model");
const SocialAccount = require("../social/social.model");
const Schedule = require("./schedule.model");
const usageService = require("../usage/usage.service");

const sanitize = (s) => ({
  id: s._id.toString(),
  userId: s.userId.toString(),
  businessId: s.businessId.toString(),
  contentId: s.contentId.toString(),
  socialAccountId: s.socialAccountId.toString(),
  // Display the user's chosen time in the UI (not the staggered execution time)
  userPreferredTime: s.userPreferredTime || s.scheduledAt,
  scheduledAt: s.scheduledAt,
  staggerOffsetMinutes: s.staggerOffsetMinutes ?? 0,
  timezone: s.timezone,
  status: s.status,
  publishAttempts: s.publishAttempts,
  lastError: s.lastError,
  publishedAt: s.publishedAt,
  externalPostId: s.externalPostId,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

const TERMINAL_STATUSES = new Set([
  SCHEDULE_STATUS.PUBLISHED,
  SCHEDULE_STATUS.CANCELLED,
]);

/**
 * Enforce per-platform posting limits before creating a schedule.
 *   1. Max posts per calendar day (UTC) for this account.
 *   2. Minimum time gap between consecutive posts to the same account.
 *
 * @param {string|ObjectId} socialAccountId
 * @param {string} platform  — "facebook" | "instagram" | etc.
 * @param {Date}   scheduledAt  — the EXECUTION time (staggered)
 * @param {string} [excludeScheduleId]  — skip this schedule (used during update)
 */
const assertPublishingAllowed = async (socialAccountId, platform, scheduledAt, excludeScheduleId) => {
  const limits = getLimits(platform);

  // ── 1. Daily limit ────────────────────────────────────────────────────────
  const dayStart = new Date(scheduledAt);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const dailyQuery = {
    socialAccountId,
    scheduledAt: { $gte: dayStart, $lt: dayEnd },
    status: { $nin: [SCHEDULE_STATUS.CANCELLED] },
  };
  if (excludeScheduleId) dailyQuery._id = { $ne: excludeScheduleId };

  const dailyCount = await Schedule.countDocuments(dailyQuery);
  if (dailyCount >= limits.maxPerDay) {
    throw new ApiError(429, `Daily posting limit (${limits.maxPerDay} posts/day) reached for this account.`, {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }

  // ── 2. Minimum interval ───────────────────────────────────────────────────
  const gapMs = limits.minIntervalMinutes * 60 * 1000;
  const windowStart = new Date(scheduledAt.getTime() - gapMs);
  const windowEnd   = new Date(scheduledAt.getTime() + gapMs);

  const intervalQuery = {
    socialAccountId,
    scheduledAt: { $gte: windowStart, $lte: windowEnd },
    status: { $nin: [SCHEDULE_STATUS.CANCELLED, SCHEDULE_STATUS.FAILED] },
  };
  if (excludeScheduleId) intervalQuery._id = { $ne: excludeScheduleId };

  const tooClose = await Schedule.findOne(intervalQuery).lean();
  if (tooClose) {
    throw new ApiError(400, `Posts to the same account must be at least ${limits.minIntervalMinutes} minutes apart.`, {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }
};

const ensureContent = async (userId, contentId) => {
  const content = await Content.findOne({ _id: contentId, userId });
  if (!content) {
    throw new ApiError(404, "Content not found.", { code: ERROR_CODES.NOT_FOUND });
  }
  if (content.status !== CONTENT_STATUS.READY) {
    throw new ApiError(400, "Content must be ready before scheduling.", {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }
  return content;
};

const ensureSocialAccount = async (userId, socialAccountId) => {
  const account = await SocialAccount.findOne({ _id: socialAccountId, userId });
  if (!account) {
    throw new ApiError(404, "Social account not found.", { code: ERROR_CODES.NOT_FOUND });
  }
  if (account.status !== SOCIAL_ACCOUNT_STATUS.CONNECTED) {
    throw new ApiError(400, "Social account is not connected.", {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }
  return account;
};

const create = async (userId, businessId, payload) => {
  await usageService.assertUsageWithinLimit(userId, "scheduledPostsCount");

  const content = await ensureContent(userId, payload.contentId);
  const account = await ensureSocialAccount(userId, payload.socialAccountId);

  if (String(content.businessId) !== String(businessId)) {
    throw new ApiError(403, "Content does not belong to the active business.", {
      code: ERROR_CODES.FORBIDDEN,
    });
  }
  if (String(account.businessId) !== String(businessId)) {
    throw new ApiError(403, "Social account does not belong to the active business.", {
      code: ERROR_CODES.FORBIDDEN,
    });
  }

  const userPreferredTime = new Date(payload.scheduledAt);
  const { executionTime, offsetMinutes } = applyStagger(
    userPreferredTime,
    userId.toString(),
    account._id.toString()
  );

  await assertPublishingAllowed(account._id, account.platform, executionTime);

  const schedule = await Schedule.create({
    userId,
    businessId,
    contentId: content._id,
    socialAccountId: account._id,
    userPreferredTime,
    scheduledAt: executionTime,
    staggerOffsetMinutes: offsetMinutes,
    timezone: payload.timezone,
    status: SCHEDULE_STATUS.PENDING,
  });

  await usageService.incrementUsage(userId, "scheduledPostsCount");

  return sanitize(schedule);
};

// Bulk create — inserts up to 28 schedules in one shot.
// Validates each item individually and collects errors per index.
// Items that pass validation are inserted even if others fail.
const bulkCreate = async (userId, businessId, items) => {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const item = items[i];
      const content = await ensureContent(userId, item.contentId);
      const account = await ensureSocialAccount(userId, item.socialAccountId);

      if (String(content.businessId) !== String(businessId)) {
        results.push({ index: i, error: "Content does not belong to the active business." });
        continue;
      }
      if (String(account.businessId) !== String(businessId)) {
        results.push({ index: i, error: "Social account does not belong to the active business." });
        continue;
      }

      const userPreferredTime = new Date(item.scheduledAt);
      const { executionTime, offsetMinutes } = applyStagger(
        userPreferredTime,
        userId.toString(),
        account._id.toString()
      );

      await assertPublishingAllowed(account._id, account.platform, executionTime);

      const schedule = await Schedule.create({
        userId,
        businessId,
        contentId: content._id,
        socialAccountId: account._id,
        userPreferredTime,
        scheduledAt: executionTime,
        staggerOffsetMinutes: offsetMinutes,
        timezone: item.timezone || "UTC",
        status: SCHEDULE_STATUS.PENDING,
      });

      await usageService.incrementUsage(userId, "scheduledPostsCount");
      results.push({ index: i, schedule: sanitize(schedule) });
    } catch (err) {
      results.push({ index: i, error: err.message || "Unknown error." });
    }
  }
  return results;
};

const list = async (userId, { page = 1, limit = 20, status, from, to } = {}) => {
  const q = { userId };
  if (status) q.status = status;
  if (from || to) {
    q.scheduledAt = {};
    if (from) q.scheduledAt.$gte = new Date(from);
    if (to)   q.scheduledAt.$lte = new Date(to);
  }
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    Schedule.find(q).sort({ scheduledAt: 1 }).skip(skip).limit(limit),
    Schedule.countDocuments(q),
  ]);
  return { data: rows.map(sanitize), page, limit, total };
};

const getById = async (userId, scheduleId) => {
  const s = await Schedule.findOne({ _id: scheduleId, userId });
  if (!s) {
    throw new ApiError(404, "Schedule not found.", { code: ERROR_CODES.NOT_FOUND });
  }
  return sanitize(s);
};

const update = async (userId, scheduleId, patch) => {
  const s = await Schedule.findOne({ _id: scheduleId, userId });
  if (!s) {
    throw new ApiError(404, "Schedule not found.", { code: ERROR_CODES.NOT_FOUND });
  }
  if (s.status !== SCHEDULE_STATUS.PENDING) {
    throw new ApiError(400, "Only pending schedules can be edited.", {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }

  if (patch.scheduledAt) {
    const account = await SocialAccount.findById(s.socialAccountId);
    const userPreferredTime = new Date(patch.scheduledAt);
    const { executionTime, offsetMinutes } = applyStagger(
      userPreferredTime,
      userId.toString(),
      s.socialAccountId.toString()
    );
    await assertPublishingAllowed(
      s.socialAccountId,
      account?.platform || "facebook",
      executionTime,
      s._id
    );
    s.userPreferredTime = userPreferredTime;
    s.scheduledAt = executionTime;
    s.staggerOffsetMinutes = offsetMinutes;
  }
  if (patch.timezone) s.timezone = patch.timezone;

  await s.save();
  return sanitize(s);
};

const cancel = async (userId, scheduleId) => {
  const s = await Schedule.findOne({ _id: scheduleId, userId });
  if (!s) {
    throw new ApiError(404, "Schedule not found.", { code: ERROR_CODES.NOT_FOUND });
  }
  if (TERMINAL_STATUSES.has(s.status)) {
    throw new ApiError(400, `Schedule is already ${s.status}.`, {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }
  if (s.status === SCHEDULE_STATUS.PROCESSING) {
    throw new ApiError(409, "Schedule is being processed and cannot be cancelled.", {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }
  s.status = SCHEDULE_STATUS.CANCELLED;
  await s.save();
  return sanitize(s);
};

module.exports = {
  create,
  bulkCreate,
  list,
  getById,
  update,
  cancel,
  sanitize,
};
