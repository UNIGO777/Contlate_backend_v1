const logger = require("../core/logger");
const { getQueues } = require("./queues");
const ContentPlan = require("../modules/poster/contentPlan.model");
const Content = require("../modules/content/content.model");
const Business = require("../modules/business/business.model");
const Schedule = require("../modules/schedule/schedule.model");
const SocialAccount = require("../modules/social/social.model");

const INTERVAL_MS = 60 * 60 * 1000; // run every hour
let timer = null;

/**
 * Daily Scheduler
 *
 * Runs hourly and handles:
 * 1. Generate tomorrow's poster images (if prompts are ready)
 * 2. Generate prompts 3 days ahead
 * 3. Auto-schedule generated posters for posting
 * 4. Queue overdue about-us welcome posters
 * 5. Cleanup orphaned local files
 */

const runOnce = async () => {
  const now = new Date();
  logger.info("[scheduler] tick", { time: now.toISOString() });

  await Promise.allSettled([
    generateTomorrowImages(now),
    generatePromptsAhead(now),
    autoSchedulePosters(now),
    queueOverdueWelcomePosters(now),
    cleanupOldLocalFiles(now),
  ]);
};

// ── 1. Safety net: queue image jobs for prompt-ready days past their scheduledGenerationAt ──
// The worker chain normally handles this; this catches failures/stuck days.
const generateTomorrowImages = async (now) => {
  const plans = await ContentPlan.find({
    status: "active",
    "days": {
      $elemMatch: {
        planStatus: "prompt_ready",
        scheduledGenerationAt: { $lte: now },
      },
    },
  }).lean();

  const queues = getQueues();
  let queued = 0;

  for (const plan of plans) {
    for (const day of plan.days) {
      if (
        day.planStatus === "prompt_ready" &&
        day.scheduledGenerationAt &&
        new Date(day.scheduledGenerationAt) <= now
      ) {
        // Use same dedup jobId as the worker chain — BullMQ rejects duplicates safely
        await queues.posterImage.add(
          `sched-image-day${day.dayNumber}-${plan.businessId}`,
          { contentPlanId: plan._id.toString(), dayNumber: day.dayNumber },
          { jobId: `image-${plan._id}-day${day.dayNumber}` }
        );
        queued++;
      }
    }
  }

  if (queued) logger.info("[scheduler] queued overdue images", { count: queued });
};

// ── 2. Safety net: queue prompts for concept-stage days whose image chain should have started ──
// Catches days the chain didn't reach (e.g. previous day failed permanently).
const generatePromptsAhead = async (now) => {
  // Target: days whose scheduledGenerationAt is within the next 24h and still concept
  const horizon = new Date(now);
  horizon.setHours(horizon.getHours() + 24);

  const plans = await ContentPlan.find({
    status: "active",
    "days": {
      $elemMatch: {
        planStatus: "concept",
        scheduledGenerationAt: { $lte: horizon },
      },
    },
  }).lean();

  const queues = getQueues();
  let queued = 0;

  for (const plan of plans) {
    for (const day of plan.days) {
      if (
        day.planStatus === "concept" &&
        day.scheduledGenerationAt &&
        new Date(day.scheduledGenerationAt) <= horizon
      ) {
        await queues.posterPrompt.add(
          `sched-prompt-day${day.dayNumber}-${plan.businessId}`,
          { contentPlanId: plan._id.toString(), dayNumber: day.dayNumber },
          { jobId: `prompt-${plan._id}-day${day.dayNumber}` }
        );
        queued++;
      }
    }
  }

  if (queued) logger.info("[scheduler] queued overdue prompts", { count: queued });
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
