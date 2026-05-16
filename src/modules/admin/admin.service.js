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
const AdminNotification = require("./adminNotification.model");
const mailService = require("../../services/mail.service");
const logger = require("../../core/logger");
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

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOf30 = new Date(now); startOf30.setDate(startOf30.getDate() - 29); startOf30.setHours(0, 0, 0, 0);

  const [
    business, subscription,
    contentCount, scheduleCount, socialCount,
    publishedThisMonth, upcomingScheduled, lastPostedAt, socialAccounts,
    publishedByDay, platformBreakdown,
  ] = await Promise.all([
    Business.findOne({ userId: user._id }).lean(),
    Subscription.findOne({ userId: user._id }).lean(),
    Content.countDocuments({ userId: user._id }),
    Schedule.countDocuments({ userId: user._id }),
    SocialAccount.countDocuments({ userId: user._id }),

    // Posts published this calendar month
    Schedule.countDocuments({
      userId: user._id,
      status: "published",
      $or: [
        { publishedAt: { $gte: startOfMonth } },
        { updatedAt:   { $gte: startOfMonth }, publishedAt: { $exists: false } },
      ],
    }),

    // Upcoming scheduled (scheduled or pending, future date)
    Schedule.countDocuments({
      userId: user._id,
      status: { $in: ["scheduled", "pending"] },
      scheduledAt: { $gte: now },
    }),

    // Most recent published date
    Schedule.findOne({ userId: user._id, status: "published" })
      .sort({ publishedAt: -1, updatedAt: -1 })
      .select("publishedAt updatedAt platforms")
      .lean(),

    // Full list of social accounts (without tokens)
    SocialAccount.find({ userId: user._id })
      .select("platform accountName accountId status lastSyncedAt createdAt tokenExpiresAt")
      .lean(),

    // Posts per day, last 30 days (for trend chart)
    Schedule.aggregate([
      { $match: { userId: user._id, status: "published",
                  $or: [
                    { publishedAt: { $gte: startOf30 } },
                    { updatedAt:   { $gte: startOf30 } },
                  ] } },
      { $group: {
        _id: { $dateToString: {
          format: "%Y-%m-%d",
          date: { $ifNull: ["$publishedAt", "$updatedAt"] },
          timezone: "Asia/Kolkata",
        } },
        count: { $sum: 1 },
      } },
      { $sort: { _id: 1 } },
    ]),

    // Post count per platform (lifetime)
    Schedule.aggregate([
      { $match: { userId: user._id } },
      { $unwind: "$platforms" },
      { $group: { _id: "$platforms", count: { $sum: 1 } } },
    ]),
  ]);

  // Fill empty days for the 30-day series
  const trendMap = new Map(publishedByDay.map((r) => [r._id, r.count]));
  const postsTrend = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(startOf30); d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    postsTrend.push({ date: key, count: trendMap.get(key) || 0 });
  }

  return {
    user: sanitizeUser(user),
    business: business || null,
    subscription: subscription || null,
    counts: {
      content: contentCount,
      schedules: scheduleCount,
      social: socialCount,
      publishedThisMonth,
      upcomingScheduled,
      lastPostedAt: lastPostedAt?.publishedAt || lastPostedAt?.updatedAt || null,
    },
    postsTrend,
    platformBreakdown: platformBreakdown.map((p) => ({ platform: p._id, count: p.count })),
    socialAccounts: socialAccounts.map((a) => ({
      id:             a._id.toString(),
      platform:       a.platform,
      accountName:    a.accountName,
      accountId:      a.accountId,
      status:         a.status,
      lastSyncedAt:   a.lastSyncedAt,
      createdAt:      a.createdAt,
      tokenExpiresAt: a.tokenExpiresAt,
    })),
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

  // Hydrate each subscription with the owning user's name/email
  const userIds = [...new Set(rows.map((r) => String(r.userId)).filter(Boolean))];
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } }).select("_id name email").lean()
    : [];
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  const data = rows.map((r) => {
    const u = userMap.get(String(r.userId));
    return {
      ...r,
      user: u
        ? { id: String(u._id), name: u.name, email: u.email }
        : null,
    };
  });

  return { data, page, limit, total };
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
  const now = new Date();
  const start30 = new Date(now); start30.setDate(start30.getDate() - 29); start30.setHours(0, 0, 0, 0);
  const start14 = new Date(now); start14.setDate(start14.getDate() - 13); start14.setHours(0, 0, 0, 0);

  const dayBucket = (dateField) => ({
    $dateToString: { format: "%Y-%m-%d", date: `$${dateField}`, timezone: "Asia/Kolkata" },
  });

  const [
    users, businesses, subscriptions, schedulesByStatus, contentTotal,
    usersByDay, contentByDay, schedulesByDay,
    platformDistribution, topUsers, recentEvents,
    activeSubs,
  ] = await Promise.all([
    User.countDocuments(),
    Business.countDocuments(),
    Subscription.aggregate([
      { $group: { _id: { plan: "$plan", status: "$status" }, count: { $sum: 1 } } },
    ]),
    Schedule.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    Content.countDocuments(),

    // last 30 days: new signups per day
    User.aggregate([
      { $match: { createdAt: { $gte: start30 } } },
      { $group: { _id: dayBucket("createdAt"), count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    // last 30 days: posts created per day
    Content.aggregate([
      { $match: { createdAt: { $gte: start30 } } },
      { $group: { _id: dayBucket("createdAt"), count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    // last 14 days: schedules grouped by day & status
    Schedule.aggregate([
      { $match: { scheduledAt: { $gte: start14 } } },
      { $group: { _id: { day: dayBucket("scheduledAt"), status: "$status" }, count: { $sum: 1 } } },
      { $sort: { "_id.day": 1 } },
    ]),
    // platform connections
    SocialAccount.aggregate([
      { $group: { _id: "$platform", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    // top users by content count
    Content.aggregate([
      { $group: { _id: "$userId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
      { $unwind: "$user" },
      { $project: { _id: 0, userId: "$_id", count: 1, name: "$user.name", email: "$user.email", plan: "$user.plan" } },
    ]),
    // recent payment events + admin notifications (merged below)
    Promise.all([
      PaymentEvent.find().sort({ createdAt: -1 }).limit(20).lean(),
      AdminNotification.find().sort({ createdAt: -1 }).limit(20).lean(),
    ]),
    // active subscriptions for revenue trend
    Subscription.find({ status: { $in: ["active", "trialing"] } })
      .select("plan status startsAt createdAt")
      .lean(),
  ]);

  // Build a flat 30-day series, filling missing days with 0
  const fillSeries = (startDate, days, rows) => {
    const map = new Map(rows.map((r) => [r._id, r.count]));
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate); d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      out.push({ date: key, count: map.get(key) || 0 });
    }
    return out;
  };

  const usersSeries   = fillSeries(start30, 30, usersByDay);
  const contentSeries = fillSeries(start30, 30, contentByDay);

  // Schedule 14-day stacked series (published vs failed vs pending vs scheduled)
  const scheduleSeries = (() => {
    const out = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(start14); d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const dayRows = schedulesByDay.filter((r) => r._id.day === key);
      const bucket = { date: key, published: 0, failed: 0, pending: 0, scheduled: 0 };
      dayRows.forEach((r) => {
        const s = r._id.status;
        if (bucket[s] !== undefined) bucket[s] = r.count;
      });
      out.push(bucket);
    }
    return out;
  })();

  // Build revenue trend (approximate MRR per day from subscription start dates)
  const revenueSeries = (() => {
    const PRICE = { basic: 0, pro: 1299, advanced: 1999 };
    const out = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(start30); d.setDate(d.getDate() + i); d.setHours(23, 59, 59, 999);
      let mrr = 0;
      activeSubs.forEach((s) => {
        const begin = s.startsAt || s.createdAt;
        if (begin && new Date(begin) <= d) mrr += PRICE[s.plan] || 0;
      });
      out.push({ date: d.toISOString().slice(0, 10), mrr });
    }
    return out;
  })();

  return {
    users,
    businesses,
    contentTotal,
    subscriptions,
    schedulesByStatus: schedulesByStatus.reduce((acc, r) => {
      acc[r._id] = r.count;
      return acc;
    }, {}),
    trends: {
      users: usersSeries,
      content: contentSeries,
      schedules: scheduleSeries,
      revenue: revenueSeries,
    },
    platformDistribution,
    topUsers,
    recentEvents: mergeRecentEvents(recentEvents[0], recentEvents[1]),
  };
};

/* Merge PaymentEvents + AdminNotifications into one chronological feed. */
const mergeRecentEvents = (paymentEvents = [], adminNotifications = []) => {
  const fromPayments = paymentEvents.map((e) => ({
    eventType:   e.eventType,
    provider:    e.provider,
    createdAt:   e.createdAt,
    processedAt: e.processedAt,
    userId:      e.userId,
    plan:        e.payload?.plan || null,
    title:       null,
    message:     null,
  }));
  const fromAdmin = adminNotifications.map((n) => ({
    eventType:      n.type,
    provider:       "admin",
    createdAt:      n.createdAt,
    processedAt:    n.createdAt,
    userId:         n.targetUserId || n.actorId || null,
    plan:           n.meta?.plan || null,
    title:          n.title,
    message:        n.message,
    audience:       n.audience || null,
    recipientCount: n.recipientCount || 0,
  }));
  return [...fromPayments, ...fromAdmin]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 15);
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

/* ───────────────────────────────────────────────────────────
   EMAIL BLAST
─────────────────────────────────────────────────────────── */

const AUDIENCE_LABELS = {
  all:      "All Users",
  pro:      "Pro Plan",
  advanced: "Advanced Plan",
  free:     "Free Plan",
  inactive: "Inactive Users",
};

const buildAudienceFilter = async (audience) => {
  // Returns a Mongo filter on the User collection.
  const baseFilter = { role: { $ne: ROLES.ADMIN }, suspendedAt: null };
  switch (audience) {
    case "pro":
      return { ...baseFilter, plan: "pro" };
    case "advanced":
      return { ...baseFilter, plan: "advanced" };
    case "free":
      return { ...baseFilter, $or: [{ plan: "basic" }, { plan: { $exists: false } }] };
    case "inactive": {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      // Users who have NOT had a published schedule in the last 30 days.
      const activeUserIds = await Schedule.distinct("userId", {
        status: "published",
        $or: [
          { publishedAt: { $gte: thirtyDaysAgo } },
          { updatedAt:   { $gte: thirtyDaysAgo } },
        ],
      });
      return { ...baseFilter, _id: { $nin: activeUserIds } };
    }
    case "all":
    default:
      return baseFilter;
  }
};

const sendEmailBlast = async (adminId, { audience, subject, body } = {}) => {
  if (!subject || !subject.trim()) {
    throw new ApiError(400, "Subject is required.");
  }
  if (!body || !body.trim()) {
    throw new ApiError(400, "Email body is required.");
  }
  if (!AUDIENCE_LABELS[audience]) {
    throw new ApiError(400, "Invalid audience.");
  }

  const filter = await buildAudienceFilter(audience);
  const recipients = await User.find(filter).select("email name").lean();

  if (recipients.length === 0) {
    // Still log it so the admin sees what happened.
    await AdminNotification.create({
      type:           "email_blast",
      title:          "Email blast — no recipients",
      message:        `Audience "${AUDIENCE_LABELS[audience]}" had 0 matching users. Nothing was sent.`,
      actorId:        adminId,
      audience,
      recipientCount: 0,
      meta:           { subject: subject.trim() },
    });
    return { sent: 0, audience, audienceLabel: AUDIENCE_LABELS[audience] };
  }

  // Build an HTML body. Keep it minimal; preserve line breaks from plain text.
  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width:560px; margin:0 auto; padding:24px; color:#111;">
      <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed); color:#fff; padding:20px 24px; border-radius:12px 12px 0 0;">
        <h1 style="margin:0; font-size:20px; font-weight:700;">PostEngine</h1>
      </div>
      <div style="background:#fff; border:1px solid #e6e8ee; border-top:none; padding:24px; border-radius:0 0 12px 12px;">
        <h2 style="margin:0 0 14px; font-size:18px; font-weight:800; color:#0b1220;">${escapeHtml(subject.trim())}</h2>
        <div style="font-size:14px; line-height:1.7; color:#374151; white-space:pre-wrap;">${escapeHtml(body.trim())}</div>
        <hr style="border:none; border-top:1px solid #eef0f4; margin:20px 0;" />
        <p style="font-size:11px; color:#9aa3b2; margin:0;">Sent to ${AUDIENCE_LABELS[audience]} · PostEngine</p>
      </div>
    </div>
  `;

  let sent = 0;
  let failed = 0;
  // Send concurrently in small batches to avoid overwhelming SMTP.
  const BATCH = 10;
  for (let i = 0; i < recipients.length; i += BATCH) {
    const slice = recipients.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      slice.map((u) => mailService.send({
        to: u.email,
        subject: subject.trim(),
        html: htmlBody,
        text: body.trim(),
      }))
    );
    results.forEach((r) => {
      if (r.status === "fulfilled" && r.value?.delivered !== false) sent += 1;
      else if (r.status === "fulfilled" && r.value?.driver === "console") sent += 1;
      else failed += 1;
    });
  }

  // Record the event for the notifications feed
  await AdminNotification.create({
    type:           "email_blast",
    title:          `Email sent to ${sent} ${sent === 1 ? "recipient" : "recipients"}`,
    message:        `“${subject.trim().slice(0, 80)}” — audience: ${AUDIENCE_LABELS[audience]}${failed ? ` · ${failed} failed` : ""}`,
    actorId:        adminId,
    audience,
    recipientCount: sent,
    meta: {
      subject:    subject.trim(),
      bodyLength: body.trim().length,
      failed,
      total:      recipients.length,
    },
  });

  logger.info("[admin] email blast sent", {
    audience, sent, failed, total: recipients.length, adminId: adminId?.toString(),
  });

  return {
    sent,
    failed,
    total: recipients.length,
    audience,
    audienceLabel: AUDIENCE_LABELS[audience],
  };
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

/* Email blast context — audience counts + recent sends. */
const getEmailBlastContext = async () => {
  const audiences = ["all", "pro", "advanced", "free", "inactive"];
  const counts = {};
  await Promise.all(audiences.map(async (a) => {
    const filter = await buildAudienceFilter(a);
    counts[a] = await User.countDocuments(filter);
  }));

  const recent = await AdminNotification
    .find({ type: "email_blast" })
    .sort({ createdAt: -1 })
    .limit(8)
    .lean();

  return {
    audienceCounts: counts,
    recentBlasts: recent.map((r) => ({
      id:             r._id.toString(),
      title:          r.title,
      message:        r.message,
      audience:       r.audience,
      audienceLabel:  AUDIENCE_LABELS[r.audience] || r.audience,
      recipientCount: r.recipientCount,
      subject:        r.meta?.subject || null,
      failed:         r.meta?.failed || 0,
      createdAt:      r.createdAt,
    })),
  };
};

/* List admin notifications (for dedicated /admin/notifications endpoint). */
const listAdminNotifications = async ({ limit = 50, type } = {}) => {
  const filter = {};
  if (type) filter.type = type;
  const rows = await AdminNotification.find(filter)
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 200))
    .lean();
  return rows;
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
  sendEmailBlast,
  getEmailBlastContext,
  listAdminNotifications,
};
