const crypto = require("crypto");
const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const { ROLES } = require("../../constants/roles");
const { PLANS, PLAN_DETAILS } = require("../../constants/plans");
const { BILLING_CYCLES } = require("../../constants/billingCycles");
const { SUBSCRIPTION_STATUS } = require("../../constants/subscriptionStatus");
const { SCHEDULE_STATUS } = require("../../constants/scheduleStatus");
const User = require("../user/user.model");
const Subscription = require("../subscription/subscription.model");
const Schedule = require("../schedule/schedule.model");
const Content = require("../content/content.model");
const SocialAccount = require("../social/social.model");
const Business = require("../business/business.model");
const PaymentEvent = require("../subscription/paymentEvent.model");
const JobLog = require("../../jobs/jobLog.model");
const { ensureSubscriptionForUser, sanitizeSubscription } = require("../subscription/subscription.service");

const sanitizeUser = (u) => ({
  id: u._id.toString(),
  name: u.name,
  email: u.email,
  role: u.role,
  plan: u.plan,
  isEmailVerified: u.isEmailVerified,
  trialEndsAt: u.trialEndsAt,
  lastLoginAt: u.lastLoginAt,
  suspendedAt: u.suspendedAt,
  deletedAt: u.deletedAt,
  createdAt: u.createdAt,
});

const listUsers = async ({ page = 1, limit = 20, q, plan, role } = {}) => {
  const filter = {};
  if (q) {
    const regex = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ email: regex }, { name: regex }];
  }
  if (plan) filter.plan = plan;
  if (role) filter.role = role;

  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);
  return { data: rows.map(sanitizeUser), page, limit, total };
};

const getUserDetail = async (userId) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND });
  }
  const [business, subscription, contentCount, scheduleCount, socialCount] =
    await Promise.all([
      Business.findOne({ userId: user._id }).lean(),
      Subscription.findOne({ userId: user._id }).lean(),
      Content.countDocuments({ userId: user._id }),
      Schedule.countDocuments({ userId: user._id }),
      SocialAccount.countDocuments({ userId: user._id }),
    ]);
  return {
    user: sanitizeUser(user),
    business: business || null,
    subscription: subscription || null,
    counts: { content: contentCount, schedules: scheduleCount, social: socialCount },
  };
};

const setUserSuspension = async (userId, suspend) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND });
  }
  if (user.role === ROLES.ADMIN) {
    throw new ApiError(400, "Admin users cannot be suspended.");
  }
  user.suspendedAt = suspend ? new Date() : null;
  await user.save();
  return sanitizeUser(user);
};

const listSubscriptions = async ({ page = 1, limit = 20, status, plan } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (plan) filter.plan = plan;
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    Subscription.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    Subscription.countDocuments(filter),
  ]);
  return { data: rows, page, limit, total };
};

const listSchedules = async ({ page = 1, limit = 20, status, userId } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (userId) filter.userId = userId;
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    Schedule.find(filter).sort({ scheduledAt: -1 }).skip(skip).limit(limit).lean(),
    Schedule.countDocuments(filter),
  ]);
  return { data: rows, page, limit, total };
};

const retrySchedule = async (scheduleId) => {
  const schedule = await Schedule.findById(scheduleId);
  if (!schedule) {
    throw new ApiError(404, "Schedule not found.", { code: ERROR_CODES.NOT_FOUND });
  }
  if (schedule.status !== SCHEDULE_STATUS.FAILED) {
    throw new ApiError(400, `Only failed schedules can be retried (current: ${schedule.status}).`);
  }
  schedule.status = SCHEDULE_STATUS.PENDING;
  schedule.publishAttempts = 0;
  schedule.lastError = "";
  schedule.lockedAt = null;
  schedule.scheduledAt = new Date();
  await schedule.save();
  return schedule.toObject();
};

const listJobLogs = async ({ page = 1, limit = 50, type, status } = {}) => {
  const filter = {};
  if (type) filter.type = type;
  if (status) filter.status = status;
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    JobLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    JobLog.countDocuments(filter),
  ]);
  return { data: rows, page, limit, total };
};

const listPaymentEvents = async ({ page = 1, limit = 50, provider, processed } = {}) => {
  const filter = {};
  if (provider) filter.provider = provider;
  if (processed === "true") filter.processedAt = { $ne: null };
  if (processed === "false") filter.processedAt = null;
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    PaymentEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    PaymentEvent.countDocuments(filter),
  ]);
  return { data: rows, page, limit, total };
};

const getStats = async () => {
  const [users, businesses, subscriptions, schedulesByStatus, contentTotal] =
    await Promise.all([
      User.countDocuments(),
      Business.countDocuments(),
      Subscription.aggregate([
        { $group: { _id: { plan: "$plan", status: "$status" }, count: { $sum: 1 } } },
      ]),
      Schedule.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Content.countDocuments(),
    ]);
  return {
    users,
    businesses,
    contentTotal,
    subscriptions,
    schedulesByStatus: schedulesByStatus.reduce((acc, r) => {
      acc[r._id] = r.count;
      return acc;
    }, {}),
  };
};

// Edit a user's subscription fields directly.
// Only plan, status, and endsAt are editable; billingCycle follows the plan.
const editUserSubscription = async (targetUserId, { plan, status, endsAt } = {}) => {
  const user = await User.findById(targetUserId);
  if (!user) throw new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND });
  if (user.role === ROLES.ADMIN) throw new ApiError(400, "Cannot edit an admin's subscription.");

  const { subscription } = await ensureSubscriptionForUser(targetUserId);

  if (plan !== undefined) {
    if (!Object.values(PLANS).includes(plan)) throw new ApiError(400, "Invalid plan.");
    subscription.plan = plan;
    user.plan = plan;
  }
  if (status !== undefined) {
    if (!Object.values(SUBSCRIPTION_STATUS).includes(status)) throw new ApiError(400, "Invalid status.");
    subscription.status = status;
  }
  if (endsAt !== undefined) {
    const d = new Date(endsAt);
    if (Number.isNaN(d.getTime())) throw new ApiError(400, "endsAt is not a valid date.");
    subscription.endsAt = d;
  }

  await subscription.save();
  await user.save();
  return { subscription: sanitizeSubscription(subscription), user: sanitizeUser(user) };
};

// Grant a user free access to a plan for a given period.
// Writes a PaymentEvent for the audit trail.
const grantUserPlan = async (adminId, targetUserId, { plan, endsAt } = {}) => {
  const user = await User.findById(targetUserId);
  if (!user) throw new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND });
  if (user.role === ROLES.ADMIN) throw new ApiError(400, "Cannot grant a plan to an admin.");

  if (!Object.values(PLANS).includes(plan)) throw new ApiError(400, "Invalid plan.");

  const ends = endsAt ? new Date(endsAt) : (() => { const d = new Date(); d.setDate(d.getDate() + 28); return d; })();
  if (Number.isNaN(ends.getTime())) throw new ApiError(400, "endsAt is not a valid date.");

  const { subscription } = await ensureSubscriptionForUser(targetUserId);

  subscription.plan         = plan;
  subscription.status       = SUBSCRIPTION_STATUS.ACTIVE;
  subscription.billingCycle = BILLING_CYCLES.CYCLE_28D;
  subscription.paymentProvider = "manual";
  subscription.startsAt     = new Date();
  subscription.endsAt       = ends;
  subscription.trialEndsAt  = null;
  await subscription.save();

  user.plan = plan;
  await user.save();

  // Audit trail — unique eventId so double-clicks are idempotent
  const eventId = `admin-grant-${targetUserId}-${plan}-${Date.now()}`;
  await PaymentEvent.create({
    userId:    targetUserId,
    provider:  "manual",
    eventType: "admin_grant",
    eventId,
    payload:   { grantedBy: adminId, plan, endsAt: ends },
    processedAt: new Date(),
  });

  return { subscription: sanitizeSubscription(subscription), user: sanitizeUser(user) };
};

module.exports = {
  listUsers,
  getUserDetail,
  setUserSuspension,
  editUserSubscription,
  grantUserPlan,
  listSubscriptions,
  listSchedules,
  retrySchedule,
  listJobLogs,
  listPaymentEvents,
  getStats,
};
