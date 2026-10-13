const logger = require("../core/logger");
const Business = require("../modules/business/business.model");
const GbpAccount = require("../modules/seo/gbpAccount.model");
const gbpReviewsService = require("../services/gbpReviews.service");
const openaiService = require("../services/openai.service");
const { sendAppNotification } = require("../utils/notifications");

const JOB_TYPE = "reviewAutoReply";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
// Per run, per business. Keeps one noisy listing from draining the OpenAI
// budget or tripping Google's write quota.
const MAX_REPLIES_PER_RUN = 5;

let timer = null;

/**
 * Reply to reviews that have no owner reply yet, for businesses that opted in.
 *
 * Replies are published publicly, so this only runs where
 * autopilot.autoReplyReviews is explicitly true — the default is false.
 */
const runForBusiness = async (business) => {
  const businessId = business._id;

  const gbp = await GbpAccount.findOne({ businessId }).select("status gbpLocationId").lean();
  if (!gbp || gbp.status !== "connected" || !gbp.gbpLocationId) return 0;

  // Served from cache unless stale; this job is not a reason to burn quota.
  const data = await gbpReviewsService.getReviews(businessId).catch((err) => {
    logger.warn("[reviewAutoReply] could not load reviews", {
      businessId: String(businessId),
      message: err.message,
    });
    return null;
  });
  if (!data) return 0;

  const pending = (data.reviews ?? []).filter((r) => !r.replyComment).slice(0, MAX_REPLIES_PER_RUN);
  if (!pending.length) return 0;

  let posted = 0;
  for (const review of pending) {
    try {
      const reply = await openaiService.generateReviewReply({
        businessName: business.businessName,
        category: business.category,
        city: business.address?.city,
        review,
      });
      await gbpReviewsService.replyToReview(businessId, review.reviewId, reply);
      posted += 1;

      // Tell the owner what came in and what went out in their name — they
      // never saw this reply before it was published.
      sendAppNotification(business.userId, "REVIEW_REPLIED", {
        authorName: review.authorName,
        starRating: review.starRating,
        replyText: reply,
      });
    } catch (err) {
      // One bad review shouldn't stop the rest; log and carry on.
      logger.warn("[reviewAutoReply] reply failed", {
        businessId: String(businessId),
        reviewId: review.reviewId,
        message: err.message,
      });
    }
  }
  return posted;
};

const runOnce = async () => {
  const businesses = await Business.find({ "autopilot.autoReplyReviews": true })
    .select("_id userId businessName category address")
    .lean();

  if (!businesses.length) return;

  let total = 0;
  for (const business of businesses) {
    total += await runForBusiness(business).catch(() => 0);
  }

  if (total) logger.info("[reviewAutoReply] batch done", { businesses: businesses.length, posted: total });
};

const start = (intervalMs = DEFAULT_INTERVAL_MS) => {
  if (timer) return;
  logger.info(`[${JOB_TYPE}] started`, { intervalMs });
  // Interval only — no run on boot, so a restart loop can't spam replies.
  timer = setInterval(() => {
    runOnce().catch((err) => logger.error(`[${JOB_TYPE}] run failed`, { message: err.message }));
  }, intervalMs);
};

const stop = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

module.exports = { start, stop, runOnce, JOB_TYPE };
