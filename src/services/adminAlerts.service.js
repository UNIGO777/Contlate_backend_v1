/**
 * Alerts that go to us rather than the client.
 *
 * Publish failures split three ways, and only two of them have someone
 * watching:
 *
 *   recoverable — the client's token expired. They get an email, they
 *                 reconnect, it resolves itself.
 *   retryable   — a third-party blip. It retries on its own.
 *   permanent   — our code or our data produced something the platform
 *                 refused. Nobody is watching this one. The post simply sits
 *                 failed, and unless somebody looks at the logs, it stays
 *                 that way.
 *
 * This is the watcher for that third case: it opens an alert, emails us every
 * hour until it is resolved, and stops once someone fixes it.
 */
const logger = require("../core/logger");
const env = require("../config/env");
const mailService = require("./mail.service");
const AdminAlert = require("../modules/admin/adminAlert.model");

const HOUR_MS = 60 * 60 * 1000;

// Hourly forever would eventually be its own outage. Two days of hourly mail
// is more than enough to get noticed; after that the alert stays open and
// visible in the admin panel without continuing to send.
const MAX_NOTIFICATIONS = env.mail?.alertMaxEmails || 48;

const recipients = () =>
  String(env.mail?.alertEmail || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Record that something needs our attention.
 *
 * Idempotent on `key`: a schedule that fails every hour updates one alert
 * instead of opening a new one each time.
 */
const raise = async ({ key, type, title, message, userId, businessId, scheduleId, meta }) => {
  try {
    const now = new Date();
    return await AdminAlert.findOneAndUpdate(
      { key },
      {
        $set: {
          type,
          title,
          message: message || "",
          userId: userId || null,
          businessId: businessId || null,
          scheduleId: scheduleId || null,
          lastSeenAt: now,
          meta: meta || {},
        },
        $inc: { occurrences: 1 },
        $setOnInsert: { key, status: "open", firstSeenAt: now, notifyCount: 0 },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );
  } catch (err) {
    // An alert that cannot be stored must never break the thing it is alerting
    // about — the publish has already failed, do not fail it twice.
    logger.warn("[adminAlerts] raise failed", { key, message: err.message });
    return null;
  }
};

/** Close an alert — the underlying problem is gone. */
const resolve = async (key, by = "system") => {
  try {
    const alert = await AdminAlert.findOneAndUpdate(
      { key, status: "open" },
      { $set: { status: "resolved", resolvedAt: new Date(), resolvedBy: by } },
      { returnDocument: "after" }
    );
    if (alert) logger.info("[adminAlerts] resolved", { key, by });
    return alert;
  } catch (err) {
    logger.warn("[adminAlerts] resolve failed", { key, message: err.message });
    return null;
  }
};

/**
 * Send the hourly digest for every open alert that is due one.
 * Called from the publisher's own tick, so it needs no separate job.
 */
const sweep = async (now = new Date()) => {
  const to = recipients();
  if (!to.length) return 0;

  const due = await AdminAlert.find({
    status: "open",
    notifyCount: { $lt: MAX_NOTIFICATIONS },
    $or: [
      { lastNotifiedAt: null },
      { lastNotifiedAt: { $lte: new Date(now.getTime() - HOUR_MS) } },
    ],
  })
    .sort({ firstSeenAt: 1 })
    .limit(25)
    .lean();

  let sent = 0;
  for (const alert of due) {
    const openFor = Math.round((now - new Date(alert.firstSeenAt)) / HOUR_MS);
    const subject = `[Prachar] ${alert.title}`;
    const text = [
      alert.title,
      "",
      alert.message,
      "",
      `Type:        ${alert.type}`,
      `Occurrences: ${alert.occurrences}`,
      `Open for:    ${openFor} hour(s)`,
      alert.scheduleId ? `Schedule:    ${alert.scheduleId}` : "",
      alert.userId ? `User:        ${alert.userId}` : "",
      "",
      "This will keep arriving every hour until the alert is resolved in the admin panel.",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await mailService.send({ to: to.join(","), subject, text });
      await AdminAlert.updateOne(
        { _id: alert._id },
        { $set: { lastNotifiedAt: now }, $inc: { notifyCount: 1 } }
      );
      sent++;
    } catch (err) {
      logger.warn("[adminAlerts] email failed", { key: alert.key, message: err.message });
    }
  }

  if (sent) logger.info("[adminAlerts] hourly alerts sent", { count: sent });
  return sent;
};

const publishFailureKey = (scheduleId) => `publish_permanent:${scheduleId}`;

module.exports = { raise, resolve, sweep, publishFailureKey, MAX_NOTIFICATIONS };
