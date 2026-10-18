const logger = require("../core/logger");
const env = require("../config/env");
const { PLANS } = require("../constants/plans");
const Business = require("../modules/business/business.model");
const User = require("../modules/user/user.model");
const AiSeo = require("../modules/ai-seo/aiSeo.model");
const GbpAccount = require("../modules/seo/gbpAccount.model");
const GbpPost = require("../modules/seo/gbpPost.model");
const { GBP_POST_STATUS } = GbpPost;
const gbpPosts = require("../services/gbpPosts.service");
const posterService = require("../services/poster.service");
const { sendAppNotification } = require("../utils/notifications");
const JobLog = require("./jobLog.model");

const JOB_TYPE = "gbpDailyPost";
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly; the work itself is daily
const MAX_ATTEMPTS = 3;

/**
 * Google Business Profile daily posting.
 *
 * One post a day per business, built around a keyword that business is trying
 * to rank for. Keywords rotate so the same term is not posted about twice in a
 * row — a GBP post only lives seven days, so the rotation is what keeps the
 * profile covering its whole keyword set over a month.
 *
 * Advanced plan only. Pro buys the social calendar; GBP SEO is the thing
 * Advanced adds, so this is where that line is drawn.
 *
 * Same rhythm as the social plan: a post is written today for tomorrow's
 * slot, and the owner can decline it up to two hours before it goes out.
 * Writing it a day ahead is what makes that window possible at all.
 */

const DECLINE_LEAD_MS = 2 * 60 * 60 * 1000;

/** Tomorrow at the business's chosen posting time. */
const nextSlotFor = async (businessId) => {
  const BusinessOffers = require("../modules/plan/businessOffers.model");
  const offers = await BusinessOffers.findOne({ businessId }).select("autoPostTime").lean();
  const [h, m] = String(offers?.autoPostTime || "12:00").split(":").map(Number);

  const slot = new Date();
  slot.setDate(slot.getDate() + 1);
  slot.setHours(Number.isFinite(h) ? h : 12, Number.isFinite(m) ? m : 0, 0, 0);
  return slot;
};

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/**
 * Pick the keyword least recently posted about, so the rotation covers the
 * whole set instead of favouring whatever sorts first.
 */
const pickKeyword = async (businessId) => {
  const seo = await AiSeo.findOne({ businessId }).select("keywords").lean();
  const keywords = (seo?.keywords || []).map((k) => k.keyword).filter(Boolean);
  if (!keywords.length) return null;

  const recent = await GbpPost.find({ businessId })
    .sort({ createdAt: -1 })
    .limit(keywords.length)
    .select("keyword")
    .lean();

  const usedAt = new Map();
  recent.forEach((p, i) => {
    if (p.keyword && !usedAt.has(p.keyword)) usedAt.set(p.keyword, i);
  });

  // Never-used keywords first, then the one used longest ago.
  let best = keywords[0];
  let bestRank = -1;
  for (const k of keywords) {
    const rank = usedAt.has(k) ? usedAt.get(k) : Number.MAX_SAFE_INTEGER;
    if (rank > bestRank) {
      bestRank = rank;
      best = k;
    }
  }
  return best;
};

/** Businesses eligible for a post today. */
const findDueBusinesses = async () => {
  const advancedUsers = await User.find({ plan: PLANS.ADVANCED })
    .select("_id")
    .lean();
  if (!advancedUsers.length) return [];

  const userIds = advancedUsers.map((u) => u._id);

  // Must have GBP connected with a chosen location.
  const accounts = await GbpAccount.find({
    userId: { $in: userIds },
    gbpLocationId: { $nin: ["", null] },
  })
    .select("businessId userId")
    .lean();
  if (!accounts.length) return [];

  const businessIds = accounts.map((a) => a.businessId);
  const businesses = await Business.find({ _id: { $in: businessIds } })
    .select("_id userId businessName autopilot")
    .lean();

  const today = startOfToday();
  const out = [];

  for (const b of businesses) {
    // The same switch that governs social auto-posting.
    if (b.autopilot?.enabled === false) continue;

    const already = await GbpPost.exists({
      businessId: b._id,
      createdAt: { $gte: today },
      status: { $ne: GBP_POST_STATUS.FAILED },
    });
    if (already) continue;

    out.push(b);
  }
  return out;
};

/** Write the post copy for a keyword. Reuses the poster prompt pipeline. */
const buildPost = async (business, keyword) => {
  const dayPlan = {
    topic: `${keyword} — ${business.businessName}`,
    description: `A Google Business Profile update for customers searching "${keyword}". Local, specific, and useful.`,
    contentType: "gbp-post",
  };

  const prompt = await posterService.generatePosterPrompt(business, dayPlan, {});

  // The caption the prompt step writes is close to what a GBP post needs, but
  // hashtags belong on Instagram, not on a Google listing.
  const summary = (prompt.caption || prompt.tagline || prompt.headline || "")
    .replace(/#[^\s#]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, gbpPosts.MAX_SUMMARY);

  return { prompt, summary };
};

const runOnce = async () => {
  if (!env.google.clientId || !env.google.clientSecret) return { created: 0, published: 0 };

  const due = await findDueBusinesses();
  if (!due.length) return { created: 0, published: 0 };

  let created = 0;
  let published = 0;
  let failed = 0;

  for (const business of due) {
    let post;
    try {
      const keyword = await pickKeyword(business._id);
      if (!keyword) {
        logger.info("[gbpDailyPost] no keywords yet", { businessId: String(business._id) });
        continue;
      }

      const { prompt, summary } = await buildPost(business, keyword);
      if (!summary) {
        logger.warn("[gbpDailyPost] empty summary", { businessId: String(business._id) });
        continue;
      }

      const image = await posterService.generatePosterImage(
        prompt.fullPrompt,
        {
          headline: prompt.headline,
          tagline: prompt.tagline,
          offer: prompt.offer,
          cta: prompt.cta,
        },
        business,
        { size: "4:5" }
      );
      const saved = await posterService.savePosterLocally(
        image.imageBuffer,
        business._id,
        `gbp_${Date.now()}`
      );

      const slot = await nextSlotFor(business._id);

      post = await GbpPost.create({
        userId: business.userId,
        businessId: business._id,
        keyword,
        summary,
        imageUrl: saved.publicUrl,
        localImagePath: saved.localPath,
        callToAction: { actionType: "LEARN_MORE", url: business.website || "" },
        status: GBP_POST_STATUS.READY,
        scheduledFor: slot,
        declineDeadlineAt: new Date(slot.getTime() - DECLINE_LEAD_MS),
        generationCost: {
          gptCost: prompt.gptCost,
          imageCost: image.imageCost,
          totalCost: prompt.gptCost + image.imageCost,
        },
      });
      created++;

      // Tell the owner now, while they can still say no.
      sendAppNotification(business.userId, "POSTER_READY", { dayNumber: 0 });
    } catch (err) {
      failed++;
      logger.error("[gbpDailyPost] generation failed", {
        businessId: String(business._id),
        message: err.message,
      });
      if (post) {
        post.status = GBP_POST_STATUS.FAILED;
        post.lastError = String(err.message || "").slice(0, 500);
        await post.save().catch(() => {});
      }
    }
  }

  if (created || failed) {
    await JobLog.create({
      type: JOB_TYPE,
      status: failed && !published ? "failed" : "success",
      attempts: created,
      lastRunAt: new Date(),
      errorMessage: failed ? `${failed} failure(s)` : "",
    }).catch(() => {});
    logger.info("[gbpDailyPost] done", { created, published, failed });
  }

  return { created, published, failed };
};

/**
 * Publish whatever is due. Separate from generation on purpose: the whole
 * point of writing a day ahead is that nothing publishes in the same pass it
 * was written, which is what leaves room to decline it.
 */
const publishDue = async () => {
  const now = new Date();

  const due = await GbpPost.find({
    status: GBP_POST_STATUS.READY,
    scheduledFor: { $lte: now },
  }).limit(25);

  let published = 0;
  let failed = 0;

  for (const post of due) {
    try {
      // Autopilot can be switched off between writing and posting.
      const business = await Business.findById(post.businessId)
        .select("autopilot businessName")
        .lean();
      if (business?.autopilot?.enabled === false) {
        post.status = GBP_POST_STATUS.SKIPPED;
        post.lastError = "Auto-posting was off at the scheduled time.";
        await post.save();
        continue;
      }

      post.status = GBP_POST_STATUS.PUBLISHING;
      post.attempts += 1;
      await post.save();

      const result = await gbpPosts.publishLocalPost({
        businessId: post.businessId,
        summary: post.summary,
        imageUrl: post.imageUrl,
        callToAction: post.callToAction,
      });

      post.status = GBP_POST_STATUS.PUBLISHED;
      post.publishedAt = new Date();
      post.googlePostName = result.name;
      post.googleSearchUrl = result.searchUrl;
      post.lastError = "";
      await post.save();
      published++;

      sendAppNotification(post.userId, "PUBLISH_SUCCESS", {
        platform: "google",
        accountName: business?.businessName || "",
      });
    } catch (err) {
      failed++;
      logger.error("[gbpDailyPost] publish failed", {
        postId: post._id.toString(),
        message: err.message,
        failureType: err.failureType || "unknown",
      });

      // A permanent failure will not come good on its own, so stop rather
      // than retrying it every hour for ever.
      post.status =
        err.failureType === "permanent" || post.attempts >= MAX_ATTEMPTS
          ? GBP_POST_STATUS.FAILED
          : GBP_POST_STATUS.READY;
      post.lastError = String(err.message || "").slice(0, 500);
      await post.save().catch(() => {});
    }
  }

  if (published || failed) {
    logger.info("[gbpDailyPost] publish pass", { published, failed });
  }
  return { published, failed };
};

let timer = null;

const start = (intervalMs = DEFAULT_INTERVAL_MS) => {
  if (timer) return timer;
  const tick = async () => {
    try {
      // Publish first: anything due now was written yesterday and has had
      // its full decline window.
      await publishDue();
      await runOnce();
    } catch (err) {
      logger.error("[gbpDailyPost] tick failed", { message: err.message });
    }
  };
  // Let the rest of the app settle before the first pass.
  setTimeout(tick, 30_000);
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  logger.info("[gbpDailyPost] started", { intervalMs });
  return timer;
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = { start, stop, runOnce, publishDue, pickKeyword, DECLINE_LEAD_MS };
