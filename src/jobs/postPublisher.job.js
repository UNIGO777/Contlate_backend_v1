const logger = require("../core/logger");
const { SCHEDULE_STATUS } = require("../constants/scheduleStatus");
const { CONTENT_STATUS } = require("../constants/contentStatus");
const Schedule = require("../modules/schedule/schedule.model");
const Content = require("../modules/content/content.model");
const SocialAccount = require("../modules/social/social.model");
const socialService = require("../services/social.service");
const usageService = require("../modules/usage/usage.service");
const JobLog = require("./jobLog.model");

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

// Atomically claim one due schedule by flipping pending -> processing.
const claimNext = async (now) =>
  Schedule.findOneAndUpdate(
    { status: SCHEDULE_STATUS.PENDING, scheduledAt: { $lte: now } },
    { $set: { status: SCHEDULE_STATUS.PROCESSING, lockedAt: now } },
    { sort: { scheduledAt: 1 }, new: true }
  );

const computeBackoffMs = (attempts) =>
  Math.min(60 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, attempts - 1));

const markFailed = async (schedule, err) => {
  schedule.publishAttempts += 1;
  schedule.lastError = err.message?.slice(0, 500) || "Unknown error";
  schedule.lockedAt = null;

  if (schedule.publishAttempts >= MAX_ATTEMPTS) {
    schedule.status = SCHEDULE_STATUS.FAILED;
  } else {
    // Schedule a retry by pushing scheduledAt forward and resetting to pending.
    schedule.status = SCHEDULE_STATUS.PENDING;
    schedule.scheduledAt = new Date(
      Date.now() + computeBackoffMs(schedule.publishAttempts)
    );
  }
  await schedule.save();
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

  const result = await socialService.publishToSocial({ account, content });

  await markPublished(schedule, result.externalPostId);

  // Track successful publish for usage analytics — never blocks the publish itself.
  await usageService
    .incrementUsage(schedule.userId, "publishedPostsCount")
    .catch((e) => logger.warn("[postPublisher] usage increment failed", { message: e.message }));

  if (content.status !== CONTENT_STATUS.PUBLISHED) {
    content.status = CONTENT_STATUS.PUBLISHED;
    await content.save();
  }
};

const runOnce = async () => {
  const now = new Date();
  await releaseStaleLocks(now);

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < BATCH_SIZE; i += 1) {
    const schedule = await claimNext(new Date());
    if (!schedule) break;

    try {
      await processOne(schedule);
      processed += 1;
    } catch (err) {
      failed += 1;
      logger.error("[postPublisher] publish failed", {
        scheduleId: schedule._id.toString(),
        message: err.message,
      });
      await markFailed(schedule, err).catch((saveErr) =>
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

module.exports = { start, stop, runOnce };
