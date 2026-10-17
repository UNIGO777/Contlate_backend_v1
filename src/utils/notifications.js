/**
 * sendAppNotification(userId, type, data)
 *
 * Single reusable entry point for ALL in-app + push notifications.
 * Call it from workers, schedulers, controllers — anywhere.
 *
 * Usage:
 *   sendAppNotification(userId, 'POSTER_READY',     { dayNumber: 3 })
 *   sendAppNotification(userId, 'POSTER_POSTED',    { dayNumber: 3, platform: 'Instagram' })
 *   sendAppNotification(userId, 'DECLINE_DEADLINE', { dayNumber: 3, hoursLeft: 2 })
 *   sendAppNotification(userId, 'QUEUE_POSITION',   { dayNumber: 3, position: 4 })
 *   sendAppNotification(userId, 'REVIEW_REPLIED',   { authorName, starRating, replyText })
 *   sendAppNotification(userId, 'PLAN_GENERATED',   {})
 *   sendAppNotification(userId, 'RENEWAL_REMINDER', {})
 *   sendAppNotification(userId, 'GENERAL',          { title: 'Hello', body: 'Custom message' })
 */

const logger = require("../core/logger");
const Notification = require("../modules/notification/notification.model");
const { sendPushNotification } = require("../services/pushNotification.service");
const { send: sendEmail } = require("../services/mail.service");

// ── Message templates ──────────────────────────────────────────────────────────
const TEMPLATES = {
  POSTER_READY: ({ dayNumber }) => ({
    notifType: "plan_day_ready",
    title: "Your poster is ready! 🎨",
    body: `Day ${dayNumber} poster is done. Tap to review before it auto-posts.`,
  }),
  PROMPT_READY: ({ dayNumber }) => ({
    notifType: "plan_day_ready",
    title: "Next post prompt ready",
    body: `Day ${dayNumber} prompt is ready. Edit it before image generation starts.`,
  }),
  POSTER_POSTED: ({ dayNumber, platform }) => ({
    notifType: "plan_day_posted",
    title: "Post is live! ✅",
    body: `Your Day ${dayNumber} post went live${platform ? ` on ${platform}` : ""}.`,
  }),
  POSTER_DECLINED: ({ dayNumber }) => ({
    notifType: "plan_day_ready",
    title: "Post declined",
    body: `Day ${dayNumber} will not be posted. Poster saved to your library.`,
  }),
  DECLINE_DEADLINE: ({ dayNumber, hoursLeft }) => ({
    notifType: "plan_day_ready",
    title: "Last chance to decline ⏰",
    body: `Day ${dayNumber} auto-posts in ${hoursLeft}h. Open app to decline.`,
  }),
  QUEUE_POSITION: ({ dayNumber, position }) => ({
    notifType: "plan_day_ready",
    title: "Your poster is queued",
    body: `Day ${dayNumber} is #${position} in line. We'll notify you when it's ready.`,
  }),
  PLAN_GENERATED: () => ({
    notifType: "plan_day_ready",
    title: "Your 28-day plan is ready! 🚀",
    body: "AI created your full content plan. Tap to explore all 28 days.",
  }),
  RENEWAL_REMINDER: () => ({
    notifType: "plan_day_ready",
    title: "Time to update your offers",
    body: "Your plan renews soon. Want to add new offers this month?",
  }),
  SOCIAL_ACCOUNT_EXPIRED: ({ platform, accountName, reason }) => ({
    notifType: "account_expired",
    title: "Social account disconnected",
    body: reason || `Your ${accountName || platform} account needs to be reconnected to continue publishing.`,
    emailTemplate: "account_expired",
  }),
  TOKEN_EXPIRING_SOON: ({ platform, accountName, daysLeft }) => ({
    notifType: "account_warning",
    title: "Connection expiring soon",
    body: `Your ${accountName || platform} connection will expire in ${daysLeft || "a few"} day${daysLeft === 1 ? "" : "s"}. Reconnect now to avoid interruption.`,
    emailTemplate: "account_expired",
  }),
  PUBLISH_SUCCESS: ({ platform, accountName }) => ({
    notifType: "publish_success",
    title: "Post is live! ✅",
    body: `Your post went live${accountName ? ` on ${accountName}` : platform ? ` on ${platform}` : ""}.`,
  }),
  PUBLISH_FAILED: ({ platform, accountName, error }) => ({
    notifType: "publish_failed",
    title: "Post failed to publish",
    body: `Could not publish to ${accountName || platform || "your account"}. ${error ? error.slice(0, 100) : ""}`.trim(),
    emailTemplate: "publish_failed",
  }),
  ACCOUNT_DISCONNECTED: ({ platform, accountName, reason }) => ({
    notifType: "account_disconnected",
    title: "Account disconnected",
    body: reason || `Your ${accountName || platform} account was disconnected. Reconnect to resume publishing.`,
    emailTemplate: "account_disconnected",
  }),
  PERMISSIONS_REVOKED: ({ platform, accountName }) => ({
    notifType: "permissions_revoked",
    title: "Permissions revoked",
    body: `Access was revoked for ${accountName || platform}. Reconnect and grant permissions to continue.`,
    emailTemplate: "permissions_revoked",
  }),
  SCHEDULE_REMINDER: ({ minutesLeft }) => ({
    notifType: "schedule_reminder",
    title: "Post going live soon ⏰",
    body: `One of your scheduled posts goes live in ${minutesLeft || 30} minutes.`,
  }),
  SCHEDULE_FAILED: ({ platform, accountName, error, reason, paused }) => ({
    notifType: "schedule_failed",
    title: paused ? "Scheduled post paused" : "Scheduled post failed",
    body: reason || `Your scheduled post to ${accountName || platform || "your account"} failed after multiple attempts.`,
    emailTemplate: "publish_failed",
  }),
  REVIEW_REPLIED: ({ authorName, starRating, replyText }) => ({
    notifType: "review_replied",
    title: `New ${starRating ? `${starRating}★ ` : ""}review — replied ⭐`,
    body: `${authorName || "A customer"} left a review and we posted a reply for you: "${String(replyText || "").slice(0, 90)}${String(replyText || "").length > 90 ? "…" : ""}"`,
  }),
  GENERAL: ({ title, body }) => ({
    notifType: "plan_day_ready",
    title: title ?? "Prachar",
    body: body ?? "",
  }),
};

/**
 * @param {string|ObjectId} userId
 * @param {keyof TEMPLATES} type
 * @param {object} data  — template-specific fields
 * @param {object} [opts]
 * @param {string} [opts.userEmail]  — if provided, sends email for templates that have emailTemplate
 * @param {string} [opts.userName]
 * @returns {Promise<void>}  — never throws; logs on failure
 */
// Which switch on the notification settings screen governs each event. An
// event with no category here is operational and always delivered.
const TYPE_CATEGORY = {
  POSTER_READY: "posts",
  PROMPT_READY: "posts",
  POSTER_POSTED: "posts",
  POSTER_DECLINED: "posts",
  DECLINE_DEADLINE: "posts",
  QUEUE_POSITION: "posts",
  PLAN_GENERATED: "posts",
  PUBLISH_SUCCESS: "posts",
  PUBLISH_FAILED: "posts",
  SCHEDULE_REMINDER: "posts",
  SCHEDULE_FAILED: "posts",
  REVIEW_REPLIED: "reviews",
  SOCIAL_ACCOUNT_EXPIRED: "accounts",
  TOKEN_EXPIRING_SOON: "accounts",
  ACCOUNT_DISCONNECTED: "accounts",
  PERMISSIONS_REVOKED: "accounts",
  RENEWAL_REMINDER: "billing",
};

// Reading the user costs one lookup per notification; treat a failed read as
// "send it", because losing a notification is worse than one extra push.
const loadPrefs = async (userId) => {
  try {
    const User = require("../modules/user/user.model");
    const u = await User.findById(userId).select("notificationPrefs").lean();
    return u?.notificationPrefs || {};
  } catch {
    return {};
  }
};

const sendAppNotification = async (userId, type, data = {}, opts = {}) => {
  const templateFn = TEMPLATES[type];
  if (!templateFn) {
    logger.warn("[notifications] unknown type", { type });
    return;
  }

  const prefs = await loadPrefs(userId);
  const category = TYPE_CATEGORY[type];
  // Turning a category off silences it everywhere, in-app included — a bell
  // badge for something the user muted is the same nuisance as the push.
  if (category && prefs[category] === false) return;

  let msg;
  try {
    msg = templateFn(data);
  } catch (err) {
    logger.warn("[notifications] template error", { type, error: err.message });
    return;
  }

  // ── In-app notification (persisted to DB) ──────────────────────────────────
  Notification.create({
    userId,
    type: msg.notifType,
    title: msg.title,
    message: msg.body,
    meta: { notificationType: type, ...data },
  }).catch((e) =>
    logger.warn("[notifications] in-app create failed", { error: e.message })
  );

  // ── Push notification (fire-and-forget) ───────────────────────────────────
  if (prefs.push !== false)
  sendPushNotification(userId, {
    title: msg.title,
    body: msg.body,
    data: { type, ...data },
  }).catch((e) =>
    logger.warn("[notifications] push failed", { error: e.message })
  );

  // ── Email (only for critical events that have a template + a recipient) ───
  if (msg.emailTemplate && opts.userEmail && prefs.email !== false) {
    sendEmail({
      to: opts.userEmail,
      template: msg.emailTemplate,
      data: { name: opts.userName || "there", ...data },
    }).catch((e) =>
      logger.warn("[notifications] email failed", { template: msg.emailTemplate, error: e.message })
    );
  }
};

module.exports = { sendAppNotification };
