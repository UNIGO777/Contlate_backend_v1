const logger = require("../core/logger");
const { SCHEDULE_STATUS } = require("../constants/scheduleStatus");
const { CONTENT_STATUS } = require("../constants/contentStatus");
const { SOCIAL_ACCOUNT_STATUS } = require("../constants/socialAccountStatus");
const Schedule = require("../modules/schedule/schedule.model");
const Content = require("../modules/content/content.model");
const ContentPlan = require("../modules/poster/contentPlan.model");
const SocialAccount = require("../modules/social/social.model");
const PublishLog = require("../modules/publish/publishLog.model");
const socialService = require("../services/social.service");
const usageService = require("../modules/usage/usage.service");
const { sendAppNotification } = require("../utils/notifications");
const JobLog = require("./jobLog.model");
const User = require("../modules/user/user.model");

const JOB_TYPE = "postPublisher";
const DEFAULT_INTERVAL_MS = 60 * 1000; // every minute
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 25;
// Reset schedules that have been "processing" for longer than this (crash recovery).
const STALE_LOCK_MS = 10 * 60 * 1000;

const releaseStaleLocks = async (now) => {
  await Schedule.updateMany(
    {
      status: SCHEDULE_STATUS.PROCESSING,
      lockedAt: { $lt: new Date(now.getTime() - STALE_LOCK_MS) },
    },
    {
      $set: { status: SCHEDULE_STATUS.PENDING, lockedAt: null },
    }
  );
};

/**
 * Auto-posting master switch. Defaults to on so existing businesses keep
 * publishing exactly as before.
 */
const isAutopilotEnabled = async (businessId) => {
  const Business = require("../modules/business/business.model");
  const b = await Business.findById(businessId).select("autopilot").lean();
  return b?.autopilot?.enabled !== false;
};

// Atomically claim one due schedule by flipping pending -> processing.
const claimNext = async (now, excludeIds = []) => {
  const q = { status: SCHEDULE_STATUS.PENDING, scheduledAt: { $lte: now } };
  // Rows deferred earlier in this tick are released back to pending and are
  // still due, so without this they would be re-claimed immediately and the
  // batch would spin on them instead of reaching anyone else's posts.
  if (excludeIds.length) q._id = { $nin: excludeIds };
  return Schedule.findOneAndUpdate(
    q,
    { $set: { status: SCHEDULE_STATUS.PROCESSING, lockedAt: now } },
    { sort: { scheduledAt: 1 }, returnDocument: 'after' }
  );
};

const computeBackoffMs = (attempts) =>
  Math.min(60 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, attempts - 1));

// Classify Meta Graph API errors — prefer structured fields from graphFetch,
// fall back to parsing the error message for legacy error paths.
const extractMetaErrorCode = (err) => {
  if (err.metaCode) return String(err.metaCode);
  const match = err.message?.match(/\bcode[:\s]+(\d+)/i) || err.message?.match(/"code"\s*:\s*(\d+)/);
  return match ? match[1] : "";
};

/**
 * Determine failure type from error.
 * Uses structured fields from graphFetch errors when available,
 * falls back to heuristic classification.
 */
const classifyFailure = (err) => {
  // Structured failureType from graphFetch → classifyMetaError
  if (err.failureType) return err.failureType;

  const code = err.metaCode || parseInt(extractMetaErrorCode(err), 10);

  // Rate limit
  if (err.isRateLimit || code === 4 || code === 17 || code === 341) return "retryable";

  // Auth / permission errors → user needs to reconnect
  if (err.isAuthError || code === 190 || code === 200 || code === 10) return "recoverable";

  // Content policy / spam
  if (code === 368 || code === 2207051) return "permanent";

  // Server errors → retryable
  if (err.statusCode >= 500) return "retryable";

  // Network errors → retryable
  if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND") return "retryable";

  // Default: retryable (benefit of the doubt)
  return "retryable";
};

/**
 * Send a notification to the schedule owner (fire-and-forget).
 */
const notifyUser = (userId, type, data) => {
  User.findById(userId).lean().then((user) => {
    const opts = user ? { userEmail: user.email, userName: user.name } : {};
    sendAppNotification(userId, type, data, opts);
  }).catch(() => {
    sendAppNotification(userId, type, data);
  });
};

const markFailed = async (schedule, err, account) => {
  schedule.publishAttempts += 1;
  schedule.lastError = err.message?.slice(0, 500) || "Unknown error";
  schedule.lockedAt = null;

  const errorCode = extractMetaErrorCode(err);
  const failureType = classifyFailure(err);

  // Branch on failure type
  if (failureType === "permanent") {
    // ── PERMANENT: content itself is the problem, no retry will help ──
    schedule.status = SCHEDULE_STATUS.FAILED;
    await schedule.save();

    PublishLog.create({
      scheduleId: schedule._id,
      socialAccountId: schedule.socialAccountId,
      contentId: schedule.contentId,
      userId: schedule.userId,
      businessId: schedule.businessId,
      platform: account?.platform || "unknown",
      publishType: "scheduled",
      status: "failed",
      errorMessage: schedule.lastError,
      errorCode,
      attempt: schedule.publishAttempts,
      executedAt: new Date(),
    }).catch((e) => logger.warn("[postPublisher] failed to create publish log", { message: e.message }));

    notifyUser(schedule.userId, "SCHEDULE_FAILED", {
      platform: account?.platform || "unknown",
      accountName: account?.accountName || "",
      error: schedule.lastError,
      reason: "Your post could not be published due to a content policy violation or invalid media.",
    });

    logger.warn("[postPublisher] permanent failure", {
      scheduleId: schedule._id.toString(),
      errorCode,
      failureType,
    });
    return;
  }

  if (failureType === "recoverable") {
    // ── RECOVERABLE: user action needed (reconnect, re-grant permissions) ──
    schedule.status = SCHEDULE_STATUS.PAUSED;
    await schedule.save();

    PublishLog.create({
      scheduleId: schedule._id,
      socialAccountId: schedule.socialAccountId,
      contentId: schedule.contentId,
      userId: schedule.userId,
      businessId: schedule.businessId,
      platform: account?.platform || "unknown",
      publishType: "scheduled",
      status: "retrying",
      errorMessage: schedule.lastError,
      errorCode,
      attempt: schedule.publishAttempts,
      executedAt: new Date(),
    }).catch((e) => logger.warn("[postPublisher] failed to create publish log", { message: e.message }));

    // Mark account as unhealthy
    if (account) {
      const accountUpdates = { healthStatus: "warning" };
      if (errorCode === "190") {
        accountUpdates.status = SOCIAL_ACCOUNT_STATUS.EXPIRED;
        accountUpdates.healthStatus = "critical";
        accountUpdates.disconnectReason = "token_expired";
      }
      SocialAccount.findByIdAndUpdate(account._id, { $set: accountUpdates }).catch(() => {});
    }

    notifyUser(schedule.userId, "SCHEDULE_FAILED", {
      platform: account?.platform || "unknown",
      accountName: account?.accountName || "",
      error: schedule.lastError,
      reason: "Your scheduled post is paused. Fix the issue and it will automatically retry.",
      paused: true,
    });

    logger.warn("[postPublisher] recoverable failure — schedule paused", {
      scheduleId: schedule._id.toString(),
      errorCode,
      failureType,
    });
    return;
  }

  // ── RETRYABLE: temporary issue, retry with backoff ──
  const isTerminal = schedule.publishAttempts >= MAX_ATTEMPTS;
  if (isTerminal) {
    schedule.status = SCHEDULE_STATUS.FAILED;
  } else {
    schedule.status = SCHEDULE_STATUS.PENDING;
    schedule.scheduledAt = new Date(
      Date.now() + computeBackoffMs(schedule.publishAttempts)
    );
  }
  await schedule.save();

  PublishLog.create({
    scheduleId: schedule._id,
    socialAccountId: schedule.socialAccountId,
    contentId: schedule.contentId,
    userId: schedule.userId,
    businessId: schedule.businessId,
    platform: account?.platform || "unknown",
    publishType: "scheduled",
    status: isTerminal ? "failed" : "retrying",
    errorMessage: schedule.lastError,
    errorCode,
    attempt: schedule.publishAttempts,
    executedAt: new Date(),
  }).catch((e) => logger.warn("[postPublisher] failed to create publish log", { message: e.message }));

  // Mark account as expired if token error (Meta code 190)
  if (errorCode === "190" && account) {
    SocialAccount.findByIdAndUpdate(account._id, {
      $set: { status: SOCIAL_ACCOUNT_STATUS.EXPIRED, healthStatus: "critical", disconnectReason: "token_expired" },
    }).catch(() => {});
  }

  // Notify user only on terminal failure (all retries exhausted)
  if (isTerminal) {
    notifyUser(schedule.userId, "SCHEDULE_FAILED", {
      platform: account?.platform || "unknown",
      accountName: account?.accountName || "",
      error: schedule.lastError,
    });
  }
};

const markPublished = async (schedule, externalPostId) => {
  schedule.status = SCHEDULE_STATUS.PUBLISHED;
  schedule.publishedAt = new Date();
  schedule.externalPostId = externalPostId || "";
  schedule.lastError = "";
  schedule.lockedAt = null;
  await schedule.save();
};

const processOne = async (schedule) => {
  const [content, account] = await Promise.all([
    Content.findById(schedule.contentId),
    SocialAccount.findById(schedule.socialAccountId),
  ]);

  if (!content) throw new Error("Content was deleted before publishing.");
  if (!account) throw new Error("Social account was removed before publishing.");
  if (content.status === CONTENT_STATUS.FAILED) {
    throw new Error("Content is in a failed state.");
  }

  // Pre-publish permission check (uses cached grantedScopes — no API call)
  const metaService = require("../services/meta.service");
  const pubCheck = metaService.canAccountPublish(account);
  if (!pubCheck.allowed) {
    const err = new Error(pubCheck.reason);
    err.failureType = "recoverable";
    throw err;
  }

  const result = await socialService.publishToSocial({ account, content });

  await markPublished(schedule, result.externalPostId);

  // Create publish log for successful publish.
  // instagram.com/<media-id> is not a real address, so only a permalink the
  // platform actually gave us is worth storing — a fabricated one is worse
  // than none, because the UI will happily link to it.
  const postUrl = result.permalink || "";
  PublishLog.create({
    scheduleId: schedule._id,
    socialAccountId: account._id,
    contentId: content._id,
    userId: schedule.userId,
    businessId: schedule.businessId,
    platform: account.platform,
    publishType: "scheduled",
    status: "success",
    externalPostId: result.externalPostId || "",
    externalPostUrl: postUrl,
    attempt: schedule.publishAttempts + 1,
    executedAt: new Date(),
  }).catch((e) => logger.warn("[postPublisher] failed to create publish log", { message: e.message }));

  // Track successful publish for usage analytics — never blocks the publish itself.
  await usageService
    .incrementUsage(schedule.userId, "publishedPostsCount")
    .catch((e) => logger.warn("[postPublisher] usage increment failed", { message: e.message }));

  if (content.status !== CONTENT_STATUS.PUBLISHED) {
    content.status = CONTENT_STATUS.PUBLISHED;
    await content.save();
  }

  // ── Mark the ContentPlan day as posted ─────────────────────────────────
  const now = new Date();
  const planUpdate = await ContentPlan.findOneAndUpdate(
    { "days.contentId": content._id },
    {
      $set: {
        "days.$.planStatus": "posted",
        "days.$.posted": true,
        "days.$.postedAt": now,
      },
    },
    { new: true }
  );

  if (planUpdate) {
    const day = planUpdate.days.find(
      (d) => d.contentId && d.contentId.toString() === content._id.toString()
    );

    // Emit socket event so frontend updates in real-time
    _emitDayPosted(planUpdate.businessId, day?.dayNumber, content.imageUrl || "");

    // Notify user: post is live
    sendAppNotification(schedule.userId, "POSTER_POSTED", {
      dayNumber: day?.dayNumber,
      platform: account.platform,
    });
  } else {
    // Scheduled post outside a content plan — send generic publish success
    sendAppNotification(schedule.userId, "PUBLISH_SUCCESS", {
      platform: account.platform,
      accountName: account.accountName,
    });
  }

  // Queue poster cleanup only once nothing else still needs the image.
  // Publishing to a second account, or a second schedule on the same content,
  // re-reads this file by URL — deleting it after the first publish left the
  // later one fetching a 404, which Instagram reports as an invalid media
  // type rather than a missing file.
  const stillNeeded = await Schedule.exists({
    contentId: content._id,
    _id: { $ne: schedule._id },
    status: { $in: [SCHEDULE_STATUS.PENDING, SCHEDULE_STATUS.PROCESSING] },
  });

  if (content.localImagePath && !content.localImageDeleted && !stillNeeded) {
    try {
      const { getQueues } = require("../queues/queues");
      const queues = getQueues();
      await queues.posterCleanup.add(
        `cleanup-${content._id}`,
        {
          contentId: content._id.toString(),
          // Where the post actually lives, plus Instagram's own copy of the
          // image, so the app has something to show once the file is gone.
          socialPostUrls: [
            {
              platform: account.platform,
              accountId: account.accountId,
              postUrl: result.permalink || "",
              postId: result.externalPostId || "",
              mediaUrl: result.mediaUrl || "",
              postedAt: new Date().toISOString(),
            },
          ],
        }
      );
    } catch (cleanupErr) {
      logger.warn("[postPublisher] failed to queue cleanup", {
        contentId: content._id.toString(),
        error: cleanupErr.message,
      });
    }
  }
};

function _emitDayPosted(businessId, dayNumber, imageUrl) {
  try {
    const { getIO } = require("../core/socket");
    const io = getIO();
    if (!io || !dayNumber) return;
    io.to(`business:${businessId}`).emit("plan:day-posted", {
      businessId: String(businessId),
      dayNumber,
      imageUrl,
      planStatus: "posted",
    });
  } catch (err) {
    logger.warn("[postPublisher] socket emit failed", { error: err.message });
  }
}

const sendScheduleReminders = async (now) => {
  // Find schedules going live in the 29–31 minute window that haven't been reminded yet
  const windowStart = new Date(now.getTime() + 29 * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + 31 * 60 * 1000);

  const due = await Schedule.find({
    status: SCHEDULE_STATUS.PENDING,
    scheduledAt: { $gte: windowStart, $lte: windowEnd },
    reminderSent: false,
  }).lean();

  if (!due.length) return;

  // Mark all as reminded in one bulk write before firing notifications
  const ids = due.map((s) => s._id);
  await Schedule.updateMany({ _id: { $in: ids } }, { $set: { reminderSent: true } });

  for (const schedule of due) {
    sendAppNotification(schedule.userId, "SCHEDULE_REMINDER", { minutesLeft: 30 });
  }
};

const runOnce = async () => {
  const now = new Date();
  await releaseStaleLocks(now);

  // Send 30-minute reminders (non-blocking — errors don't abort publish loop)
  sendScheduleReminders(now).catch((e) =>
    logger.warn("[postPublisher] reminder check failed", { message: e.message })
  );

  let processed = 0;
  let failed = 0;

  const deferred = [];

  for (let i = 0; i < BATCH_SIZE; i += 1) {
    const schedule = await claimNext(new Date(), deferred);
    if (!schedule) break;

    // The autopilot switch governs the plan posting by itself. A post the
    // user scheduled by hand is an explicit instruction and goes out either
    // way, so only autopilot's own rows are held back here.
    const autoOn =
      schedule.source !== "autopilot" || (await isAutopilotEnabled(schedule.businessId));
    if (!autoOn) {
      deferred.push(schedule._id);
      await Schedule.updateOne(
        { _id: schedule._id },
        { $set: { status: SCHEDULE_STATUS.PENDING, lockedAt: null } }
      );
      logger.info("[postPublisher] skipped — autopilot off", {
        businessId: String(schedule.businessId),
        scheduleId: schedule._id.toString(),
      });
      continue;
    }

    try {
      await processOne(schedule);
      processed += 1;
    } catch (err) {
      failed += 1;
      logger.error("[postPublisher] publish failed", {
        scheduleId: schedule._id.toString(),
        message: err.message,
        failureType: classifyFailure(err),
      });
      // Try to load the account for error classification (token expiry etc.)
      const acct = await SocialAccount.findById(schedule.socialAccountId).catch(() => null);
      await markFailed(schedule, err, acct).catch((saveErr) =>
        logger.error("[postPublisher] failed to record failure", {
          scheduleId: schedule._id.toString(),
          message: saveErr.message,
        })
      );
    }
  }

  if (processed || failed) {
    await JobLog.create({
      type: JOB_TYPE,
      status: failed && !processed ? "failed" : "success",
      attempts: processed + failed,
      lastRunAt: now,
      errorMessage: failed ? `${failed} failure(s) in batch` : "",
    }).catch(() => {});
    logger.info("[postPublisher] batch done", { processed, failed });
  }

  return { processed, failed };
};

/**
 * Resume all PAUSED schedules for a specific social account.
 * Called after successful reconnect or token refresh.
 */
const resumePausedSchedules = async (socialAccountId) => {
  const result = await Schedule.updateMany(
    {
      socialAccountId,
      status: SCHEDULE_STATUS.PAUSED,
    },
    {
      $set: {
        status: SCHEDULE_STATUS.PENDING,
        publishAttempts: 0,
        lastError: "",
        scheduledAt: new Date(), // publish immediately on next tick
      },
    }
  );

  if (result.modifiedCount > 0) {
    logger.info("[postPublisher] resumed paused schedules", {
      socialAccountId: socialAccountId.toString(),
      count: result.modifiedCount,
    });
  }

  return result.modifiedCount;
};

let timer = null;

const start = (intervalMs = DEFAULT_INTERVAL_MS) => {
  if (timer) return timer;
  const tick = async () => {
    try {
      await runOnce();
    } catch (err) {
      logger.error("[postPublisher] tick failed", {
        message: err.message,
        stack: err.stack,
      });
    }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = { start, stop, runOnce, resumePausedSchedules };
