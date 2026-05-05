const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const { PLAN_LIMITS, USAGE_COUNTER_TO_LIMIT_KEY } = require("../../constants/limits");
const { PLANS } = require("../../constants/plans");
const User = require("../user/user.model");
const Usage = require("./usage.model");

const TRACKABLE_FIELDS = Object.keys(USAGE_COUNTER_TO_LIMIT_KEY);

const buildDateKey = (date = new Date()) => date.toISOString().slice(0, 10);

const sanitizeUsage = (u) => ({
  id: u._id.toString(),
  userId: u.userId.toString(),
  dateKey: u.dateKey,
  uploadsCount: u.uploadsCount,
  scheduledPostsCount: u.scheduledPostsCount,
  publishedPostsCount: u.publishedPostsCount,
  aiPostersCount: u.aiPostersCount,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
});

const getUserPlan = async (userId) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND });
  }
  return user.plan || PLANS.BASIC;
};

const getOrCreateDailyUsage = async (userId, dateKey = buildDateKey()) => {
  const update = { $setOnInsert: { userId, dateKey } };
  return Usage.findOneAndUpdate({ userId, dateKey }, update, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  });
};

const getUsageSummary = async (userId) => {
  const plan = await getUserPlan(userId);
  const usage = await getOrCreateDailyUsage(userId);
  const limits = PLAN_LIMITS[plan];

  const remaining = {};
  for (const [counter, limitKey] of Object.entries(USAGE_COUNTER_TO_LIMIT_KEY)) {
    if (!limitKey) continue;
    const limit = limits?.[limitKey];
    remaining[counter] = typeof limit === "number" ? Math.max(0, limit - usage[counter]) : null;
  }

  return {
    plan,
    limits,
    today: sanitizeUsage(usage),
    remaining,
  };
};

const incrementUsage = async (userId, field, amount = 1) => {
  if (!TRACKABLE_FIELDS.includes(field)) {
    throw new ApiError(400, "Usage field is invalid.", {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }
  const dateKey = buildDateKey();
  const usage = await Usage.findOneAndUpdate(
    { userId, dateKey },
    { $inc: { [field]: amount }, $setOnInsert: { userId, dateKey } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return sanitizeUsage(usage);
};

const checkLimit = async (userId, field) => {
  if (!TRACKABLE_FIELDS.includes(field)) {
    throw new ApiError(400, "Usage field is invalid.", {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }
  const limitKey = USAGE_COUNTER_TO_LIMIT_KEY[field];
  if (!limitKey) {
    return { used: 0, limit: null, remaining: null };
  }
  const plan = await getUserPlan(userId);
  const usage = await getOrCreateDailyUsage(userId);
  const limit = PLAN_LIMITS[plan]?.[limitKey];
  const used = usage[field] || 0;
  return {
    used,
    limit: typeof limit === "number" ? limit : null,
    remaining: typeof limit === "number" ? Math.max(0, limit - used) : null,
  };
};

const assertUsageWithinLimit = async (userId, field) => {
  const res = await checkLimit(userId, field);
  if (res.limit !== null && res.used >= res.limit) {
    throw new ApiError(403, `Daily limit reached for ${field}.`, {
      code: ERROR_CODES.PLAN_LIMIT_REACHED,
      details: { field, used: res.used, limit: res.limit },
    });
  }
  return res;
};

const getUsageHistory = async (userId, { from, to } = {}) => {
  const q = { userId };
  if (from || to) q.dateKey = {};
  if (from) q.dateKey.$gte = from;
  if (to) q.dateKey.$lte = to;
  const rows = await Usage.find(q).sort({ dateKey: -1 }).limit(90);
  return rows.map(sanitizeUsage);
};

module.exports = {
  buildDateKey,
  getOrCreateDailyUsage,
  getUsageSummary,
  getUsageHistory,
  incrementUsage,
  checkLimit,
  assertUsageWithinLimit,
};
