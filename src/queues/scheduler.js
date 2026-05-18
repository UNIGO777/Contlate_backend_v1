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

// ── 1. Generate poster images for tomorrow ──
const generateTomorrowImages = async (now) => {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStart = new Date(tomorrow.toISOString().split("T")[0]);
  const tomorrowEnd = new Date(tomorrowStart);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

  const plans = await ContentPlan.find({
    status: "active",
    "days": {
      $elemMatch: {
        date: { $gte: tomorrowStart, $lt: tomorrowEnd },
        promptStatus: { $in: ["ready", "edited"] },
        imageStatus: "pending",
      },
    },
  }).lean();

  const queues = getQueues();
  let queued = 0;

  for (const plan of plans) {
    const day = plan.days.find(
      (d) =>
        new Date(d.date) >= tomorrowStart &&
        new Date(d.date) < tomorrowEnd &&
        (d.promptStatus === "ready" || d.promptStatus === "edited") &&
        d.imageStatus === "pending"
    );
    if (!day) continue;

    await queues.posterImage.add(
      `sched-image-day${day.dayNumber}-${plan.businessId}`,
      { contentPlanId: plan._id.toString(), dayNumber: day.dayNumber }
    );
    queued++;
  }

  if (queued) logger.info("[scheduler] queued tomorrow images", { count: queued });
};

// ── 2. Generate prompts 3 days ahead ──
const generatePromptsAhead = async (now) => {
  const target = new Date(now);
  target.setDate(target.getDate() + 3);
  const targetStart = new Date(target.toISOString().split("T")[0]);
  const targetEnd = new Date(targetStart);
  targetEnd.setDate(targetEnd.getDate() + 1);

  const plans = await ContentPlan.find({
    status: "active",
    "days": {
      $elemMatch: {
        date: { $gte: targetStart, $lt: targetEnd },
        promptStatus: "pending",
      },
    },
  }).lean();

  const queues = getQueues();
  let queued = 0;

  for (const plan of plans) {
    const day = plan.days.find(
      (d) =>
        new Date(d.date) >= targetStart &&
        new Date(d.date) < targetEnd &&
        d.promptStatus === "pending"
    );
    if (!day) continue;

    await queues.posterPrompt.add(
      `sched-prompt-day${day.dayNumber}-${plan.businessId}`,
      { contentPlanId: plan._id.toString(), dayNumber: day.dayNumber }
    );
    queued++;
  }

  if (queued) logger.info("[scheduler] queued prompts ahead", { count: queued });
};

// ── 3. Auto-schedule generated posters for posting ──
const autoSchedulePosters = async (now) => {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStart = new Date(tomorrow.toISOString().split("T")[0]);
  const tomorrowEnd = new Date(tomorrowStart);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

  // Find plans with ready images for tomorrow that haven't been scheduled yet
  const plans = await ContentPlan.find({
    status: "active",
    "days": {
      $elemMatch: {
        date: { $gte: tomorrowStart, $lt: tomorrowEnd },
        imageStatus: "ready",
        posted: false,
        contentId: { $ne: null },
      },
    },
  }).lean();

  let scheduled = 0;

  for (const plan of plans) {
    const day = plan.days.find(
      (d) =>
        new Date(d.date) >= tomorrowStart &&
        new Date(d.date) < tomorrowEnd &&
        d.imageStatus === "ready" &&
        !d.posted &&
        d.contentId
    );
    if (!day) continue;

    // Check if already scheduled
    const existing = await Schedule.findOne({ contentId: day.contentId });
    if (existing) continue;

    // Find connected social accounts
    const accounts = await SocialAccount.find({
      businessId: plan.businessId,
      status: "connected",
    }).lean();

    if (!accounts.length) continue;

    // Get business timezone for posting time
    const business = await Business.findById(plan.businessId).lean();
    const tz = business?.timezone || "UTC";

    // Schedule for 10:00 AM in business timezone
    const postTime = new Date(day.date);
    postTime.setHours(10, 0, 0, 0);

    for (const account of accounts) {
      await Schedule.create({
        userId: plan.userId,
        businessId: plan.businessId,
        contentId: day.contentId,
        socialAccountId: account._id,
        scheduledAt: postTime,
        timezone: tz,
        status: "pending",
      });
      scheduled++;
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
