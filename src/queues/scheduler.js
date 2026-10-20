const logger = require("../core/logger");
const { getQueues } = require("./queues");
const ContentPlan = require("../modules/poster/contentPlan.model");
const Content = require("../modules/content/content.model");
const Business = require("../modules/business/business.model");
const Schedule = require("../modules/schedule/schedule.model");
const SocialAccount = require("../modules/social/social.model");
const planChain = require("../services/planChain.service");

const INTERVAL_MS = 60 * 60 * 1000; // run every hour
let timer = null;

/**
 * Daily Scheduler
 *
 * Runs hourly and handles:
 * 1. Generate tomorrow's poster images (if prompts are ready)
 * 2. Restart plans whose event-driven chain has stalled
 * 3. Auto-schedule generated posters for posting
 * 4. Queue overdue about-us welcome posters
 * 5. Cleanup orphaned local files
 */

const runOnce = async () => {
  const now = new Date();
  logger.info("[scheduler] tick", { time: now.toISOString() });

  await Promise.allSettled([
    generateTomorrowImages(now),
    recoverStalledPlans(now),
    autoSchedulePosters(now),
    queueOverdueWelcomePosters(now),
    cleanupOldLocalFiles(now),
  ]);
};

// ── 1. Safety net: queue image jobs for days past their scheduledGenerationAt ──
// The worker chain normally handles this; this catches failures/stuck days.
//
// Both stages are recoverable here:
//   prompt_ready — the prompt landed but the image job was never queued.
//   in_queue     — a job was queued, then lost (Redis restart without
//                  persistence) or it failed, in which case the image worker
//                  reverts the day to in_queue. Nothing else reads in_queue,
//                  so without this the day sits there forever.
const RECOVERABLE = ["prompt_ready", "in_queue"];
const MAX_IMAGE_RETRIES = 5;

const generateTomorrowImages = async (now) => {
  const plans = await ContentPlan.find({
    status: "active",
    "days": {
      $elemMatch: {
        planStatus: { $in: RECOVERABLE },
        scheduledGenerationAt: { $lte: now },
      },
    },
  }).lean();

  const queues = getQueues();
  let queued = 0;

  for (const plan of plans) {
    for (const day of plan.days) {
      if (
        !RECOVERABLE.includes(day.planStatus) ||
        !day.scheduledGenerationAt ||
        new Date(day.scheduledGenerationAt) > now
      ) {
        continue;
      }

      // Each attempt costs an image generation, so stop retrying a day that
      // keeps failing rather than burning credits on it every hour.
      if ((day.retryCount || 0) >= MAX_IMAGE_RETRIES) {
        logger.warn("[scheduler] image retries exhausted", {
          contentPlanId: String(plan._id),
          dayNumber: day.dayNumber,
          lastError: day.lastError,
        });
        continue;
      }

      const jobId = `image-${plan._id}-day${day.dayNumber}`;
      const existing = await queues.posterImage.getJob(jobId);

      if (existing) {
        const state = await existing.getState();
        // Already in flight — leave it alone.
        if (state === "active" || state === "waiting") continue;
        if (state === "delayed") {
          // Due but not promoted yet; nudge it instead of replacing it.
          await existing.promote().catch(() => {});
          continue;
        }
        // completed/failed keep their id (removeOnFail retains 1000 of them),
        // and BullMQ silently drops an add that reuses a live id — so the
        // re-queue below would be a no-op unless the old job is cleared.
        await existing.remove().catch(() => {});
      }

      await queues.posterImage.add(
        `sched-image-day${day.dayNumber}-${plan.businessId}`,
        { contentPlanId: plan._id.toString(), dayNumber: day.dayNumber },
        { jobId }
      );
      queued++;
    }
  }

  if (queued) logger.info("[scheduler] queued overdue images", { count: queued });
};

// ── 2. Safety net: restart plans whose chain has stalled ──
//
// The chain is event-driven now: publishing a poster starts the next one.
// That is the fast path, and it has one weakness — it depends on an event
// arriving. If the process restarts mid-publish, or an exception lands
// between marking a day posted and queueing the next, nothing is left to
// nudge it and the plan stops for good.
//
// This asks the question the old date-driven version could not: not "which
// day does the calendar say is due" but "is this plan stuck?" A plan with
// nothing in flight and days still to run has lost its event, so re-fire it.
// advanceChain is idempotent, so a plan that is merely between states is
// left alone.
const recoverStalledPlans = async (now) => {
  const plans = await ContentPlan.find({ status: "active" })
    .select(
      "_id userId businessId status days.dayNumber days.planStatus days.posted days.chainQueuedAt"
    )
    .lean();

  let restarted = 0;

  for (const plan of plans) {
    if (plan.days.some((d) => planChain.isInFlight(d))) continue;      // working fine
    if (!plan.days.some((d) => d.planStatus === "concept")) continue; // cycle done

    const result = await planChain.advanceChain({ planId: plan._id, reason: "stalled" });
    if (result.advanced) {
      restarted++;
      logger.warn("[scheduler] restarted a stalled plan", {
        planId: String(plan._id),
        dayNumber: result.dayNumber,
      });
    }
  }

  if (restarted) logger.info("[scheduler] stalled plans restarted", { count: restarted });
};

// ── 3. Auto-schedule generated posters for posting ──
// Uses scheduledPostAt from the ContentPlan day (set at plan generation time).
// Skips days the user declined. Only schedules if not already in Schedule collection.
const autoSchedulePosters = async (now) => {
  // Look ahead 36h to catch anything scheduled for next day
  const horizon = new Date(now);
  horizon.setHours(horizon.getHours() + 36);

  const plans = await ContentPlan.find({
    status: "active",
    "days": {
      $elemMatch: {
        planStatus: { $in: ["ready", "approved"] },
        scheduledPostAt: { $gte: now, $lte: horizon },
        contentId: { $ne: null },
      },
    },
  }).lean();

  let scheduled = 0;

  for (const plan of plans) {
    const candidates = plan.days.filter(
      (d) =>
        (d.planStatus === "ready" || d.planStatus === "approved") &&
        d.scheduledPostAt &&
        new Date(d.scheduledPostAt) >= now &&
        new Date(d.scheduledPostAt) <= horizon &&
        d.contentId
    );

    for (const day of candidates) {
      // Check if already scheduled
      const existing = await Schedule.findOne({ contentId: day.contentId });
      if (existing) continue;

      // Find connected social accounts
      const accounts = await SocialAccount.find({
        businessId: plan.businessId,
        status: "connected",
      }).lean();

      if (!accounts.length) continue;

      const business = await Business.findById(plan.businessId).lean();
      // Auto-posting turned off means the plan should not queue itself at
      // all, rather than queueing rows the publisher then has to refuse.
      if (business?.autopilot?.enabled === false) continue;
      const tz = business?.timezone || "UTC";

      for (const account of accounts) {
        await Schedule.create({
          userId: plan.userId,
          businessId: plan.businessId,
          contentId: day.contentId,
          socialAccountId: account._id,
          scheduledAt: new Date(day.scheduledPostAt),
          timezone: tz,
          status: "pending",
          source: "autopilot",
        });
        scheduled++;
      }
    }
  }

  if (scheduled) logger.info("[scheduler] auto-scheduled posts", { count: scheduled });
};

// ── 4. Queue overdue about-us welcome posters ──
const queueOverdueWelcomePosters = async (now) => {
  const businesses = await Business.find({
    "welcomePosters.aboutUsDone": false,
    "welcomePosters.aboutUsScheduledAt": { $lte: now, $ne: null },
  }).lean();

  const queues = getQueues();
  let queued = 0;

  for (const biz of businesses) {
    await queues.welcomePoster.add(
      `about-us-${biz._id}`,
      { businessId: biz._id.toString(), userId: biz.userId.toString(), posterType: "about-us" },
      { jobId: `about-us-${biz._id}` } // prevent duplicates
    );
    queued++;
  }

  if (queued) logger.info("[scheduler] queued about-us posters", { count: queued });
};

// ── 5. Cleanup old local files (posted > 24h ago) ──
const cleanupOldLocalFiles = async (now) => {
  const cutoff = new Date(now);
  cutoff.setHours(cutoff.getHours() - 24);

  const stale = await Content.find({
    localImagePath: { $ne: "" },
    localImageDeleted: false,
    sourceType: { $in: ["ai-poster", "welcome-poster"] },
    status: "published",
    updatedAt: { $lte: cutoff },
  })
    .select("_id")
    .limit(50)
    .lean();

  if (!stale.length) return;

  const queues = getQueues();
  const jobs = stale.map((c) => ({
    name: `cleanup-${c._id}`,
    data: { contentId: c._id.toString(), socialPostUrls: [] },
  }));
  await queues.posterCleanup.addBulk(jobs);

  logger.info("[scheduler] queued stale cleanup", { count: stale.length });
};

// ── Start / Stop ──

const start = (intervalMs = INTERVAL_MS) => {
  if (timer) return timer;
  const tick = async () => {
    try {
      await runOnce();
    } catch (err) {
      logger.error("[scheduler] tick failed", { message: err.message, stack: err.stack });
    }
  };
  // Run first tick after a short delay to let workers start
  setTimeout(tick, 10_000);
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  logger.info("[scheduler] started", { intervalMs });
  return timer;
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = { start, stop, runOnce };
