const ApiError = require("../../core/ApiError");
const logger = require("../../core/logger");
const { ERROR_CODES } = require("../../constants/errorCodes");
const { SCHEDULE_STATUS } = require("../../constants/scheduleStatus");
const { CONTENT_STATUS } = require("../../constants/contentStatus");
const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");
const { applyStagger } = require("../../utils/scheduleStagger");
const { getLimits } = require("../../constants/publishingLimits");
const Content = require("../content/content.model");
const SocialAccount = require("../social/social.model");
const Schedule = require("./schedule.model");
const ContentPlan = require("../poster/contentPlan.model");
const env = require("../../config/env");
const usageService = require("../usage/usage.service");

const sanitize = (s) => ({
  id: s._id.toString(),
  userId: s.userId.toString(),
  businessId: s.businessId.toString(),
  contentId: s.contentId.toString(),
  socialAccountId: s.socialAccountId.toString(),
  // Kept for the record, but the UI shows scheduledAt — the staggered time is
  // when the post actually goes out, and showing the picked time instead made
  // posts look late by the offset.
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
    throw new ApiError(429, `This account has reached its limit of ${limits.maxPerDay} posts for that day.`, {
      code: ERROR_CODES.SCHEDULE_CONFLICT,
      details: { maxPerDay: limits.maxPerDay },
    });
  }

  // ── 2. Minimum interval ───────────────────────────────────────────────────
  // Relaxed for testing so several posts can share a date; the daily ceiling
  // above is Meta's own and stays enforced either way.
  if (env.schedule.relaxLimits) return;
  const gapMs = limits.minIntervalMinutes * 60 * 1000;
  const windowStart = new Date(scheduledAt.getTime() - gapMs);
  const windowEnd   = new Date(scheduledAt.getTime() + gapMs);

  const intervalQuery = {
    socialAccountId,
    scheduledAt: { $gte: windowStart, $lte: windowEnd },
    status: { $nin: [SCHEDULE_STATUS.CANCELLED, SCHEDULE_STATUS.FAILED] },
  };
  if (excludeScheduleId) intervalQuery._id = { $ne: excludeScheduleId };

  const tooClose = await Schedule.findOne(intervalQuery).sort({ scheduledAt: 1 }).lean();
  if (tooClose) {
    // The clash is checked against the staggered execution time, which is not
    // the time the user picked, so naming the gap alone left no way to work
    // out what went wrong. Hand back the conflicting slot too.
    const clashAt = tooClose.scheduledAt;
    throw new ApiError(
      400,
      `This account already has a post scheduled within ${limits.minIntervalMinutes} minutes of that time. Pick a time further away, or cancel the other post.`,
      {
        code: ERROR_CODES.SCHEDULE_CONFLICT,
        details: {
          minIntervalMinutes: limits.minIntervalMinutes,
          conflictScheduleId: tooClose._id.toString(),
          conflictAt: new Date(clashAt).toISOString(),
        },
      }
    );
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

// The content plan day carries the time the app shows in the detail sheet.
// It stores the staggered execution time, which is when the post really goes
// out — not the time the user picked.
// Scheduling by hand only wrote a Schedule row, so the sheet kept offering
// to schedule a post that was already scheduled. Mirror the time onto the
// day whenever it changes.
const syncPlanDayScheduledAt = async (contentId, scheduledAt) => {
  try {
    await ContentPlan.updateOne(
      { "days.contentId": contentId },
      { $set: { "days.$.scheduledPostAt": scheduledAt } }
    );
  } catch (err) {
    // The row is the source of truth for publishing; a stale display time
    // must never fail the schedule itself.
    logger.warn("[schedule] plan day sync failed", { message: err.message });
  }
};

// The plan limit counts posts, not schedule rows. One post sent to both
// Facebook and Instagram writes a row per account, so charging per row would
// make "2 posts a day" mean one post for anyone with two accounts connected.
// Only the first row for a piece of content is charged.
const isFirstScheduleFor = async (userId, contentId) =>
  !(await Schedule.exists({ userId, contentId }));

const create = async (userId, businessId, payload) => {
  const content = await ensureContent(userId, payload.contentId);
  const account = await ensureSocialAccount(userId, payload.socialAccountId);

  const charge = await isFirstScheduleFor(userId, content._id);
  if (charge && !env.schedule.relaxLimits) {
    await usageService.assertUsageWithinLimit(userId, "scheduledPostsCount");
  }

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

  if (charge) {
    await usageService.incrementUsage(userId, "scheduledPostsCount");
  }

  await syncPlanDayScheduledAt(content._id, executionTime);

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

      const charge = await isFirstScheduleFor(userId, content._id);
      if (charge && !env.schedule.relaxLimits) {
        await usageService.assertUsageWithinLimit(userId, "scheduledPostsCount");
      }

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

      if (charge) {
        await usageService.incrementUsage(userId, "scheduledPostsCount");
      }
      await syncPlanDayScheduledAt(content._id, executionTime);
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
  if (patch.scheduledAt) {
    await syncPlanDayScheduledAt(s.contentId, s.scheduledAt);
  }
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

  // Other accounts may still be posting this content, so only clear the
  // displayed time once nothing is left pending for it.
  const stillLive = await Schedule.exists({
    contentId: s.contentId,
    status: { $nin: [SCHEDULE_STATUS.CANCELLED, SCHEDULE_STATUS.FAILED] },
  });
  if (!stillLive) await syncPlanDayScheduledAt(s.contentId, null);

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
