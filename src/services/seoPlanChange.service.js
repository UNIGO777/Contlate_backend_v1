const Business = require("../modules/business/business.model");
const SeoKeywordCache = require("../modules/seo/seoKeywordCache.model");
const { PLANS } = require("../constants/plans");
const seoCacheService = require("./seoCache.service");
const seoService = require("./seo.service");
const logger = require("../core/logger");

const PREMIUM_PLANS = [PLANS.PRO, PLANS.ADVANCED];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Handle premium upgrade — fires when user.plan changes from BASIC to a premium tier.
 *
 * 1. Increment premiumUserCount on the relevant seo_keyword_cache entry
 * 2. If rank data is stale (> 7 days), queue immediate rank refresh
 * 3. If cache expired, queue full keyword refresh too
 *
 * @param {string} userId - User ID
 */
async function handleUpgrade(userId) {
  const business = await Business.findOne({ userId });
  if (!business) {
    logger.warn("[seoPlanChange] upgrade — no business found", { userId });
    return;
  }

  const cacheKey = business.seo?.cacheKey;
  if (!cacheKey) {
    logger.info("[seoPlanChange] upgrade — business has no SEO cacheKey yet", {
      businessId: business._id,
    });
    return;
  }

  // Check if rank data is stale
  const lastRank = business.seo.lastRankRefresh;
  const rankStale = !lastRank || (Date.now() - lastRank.getTime() > SEVEN_DAYS_MS);

  if (rankStale) {
    // Check if cache is also expired — if so, do full refresh, otherwise rank only
    const cachedEntry = await seoCacheService.checkCache(cacheKey);

    if (!cachedEntry) {
      // Cache expired — full refresh (keywords + rank)
      // refreshBusinessSEO handles premiumUserCount increment via alreadyCounted guard
      logger.info("[seoPlanChange] cache expired, queuing full SEO refresh", {
        businessId: business._id,
      });
      seoService.refreshBusinessSEO(business._id).catch((err) => {
        logger.error("[seoPlanChange] full refresh after upgrade failed", {
          businessId: business._id,
          error: err.message,
        });
      });
    } else {
      // Cache fresh, just refresh rank — increment premiumUserCount here
      // since refreshRankOnly doesn't touch the counter
      await SeoKeywordCache.updateOne(
        { cacheKey },
        { $inc: { premiumUserCount: 1 } }
      );
      logger.info("[seoPlanChange] rank stale, queuing rank-only refresh", {
        businessId: business._id,
      });
      seoService.refreshRankOnly(business._id).catch((err) => {
        logger.error("[seoPlanChange] rank refresh after upgrade failed", {
          businessId: business._id,
          error: err.message,
        });
      });
    }
  } else {
    // Rank is fresh — just increment premiumUserCount, no refresh needed
    await SeoKeywordCache.updateOne(
      { cacheKey },
      { $inc: { premiumUserCount: 1 } }
    );
    logger.info("[seoPlanChange] premium upgrade — rank fresh, incremented premiumUserCount only", {
      businessId: business._id,
      cacheKey,
    });
  }
}

/**
 * Handle premium downgrade / churn — fires when user.plan changes from premium to BASIC
 * or account is deleted.
 *
 * 1. Decrement premiumUserCount on the relevant seo_keyword_cache entry
 *    (with $max: 0 to prevent negative counts)
 * 2. No SEO data deleted — free user keeps their static data
 *
 * @param {string} userId - User ID
 */
async function handleDowngrade(userId) {
  const business = await Business.findOne({ userId });
  if (!business) {
    logger.warn("[seoPlanChange] downgrade — no business found", { userId });
    return;
  }

  const cacheKey = business.seo?.cacheKey;
  if (!cacheKey) {
    return;
  }

  // Decrement premiumUserCount, floor at 0
  const result = await SeoKeywordCache.findOneAndUpdate(
    { cacheKey, premiumUserCount: { $gt: 0 } },
    { $inc: { premiumUserCount: -1 } },
    { new: true }
  );

  logger.info("[seoPlanChange] premium downgrade — decremented premiumUserCount", {
    businessId: business._id,
    cacheKey,
    newCount: result?.premiumUserCount ?? "no cache entry",
  });
}

/**
 * Detect plan change direction and dispatch to the correct handler.
 * Call this when user.plan changes.
 *
 * @param {string} userId - User ID
 * @param {string} oldPlan - Previous plan value
 * @param {string} newPlan - New plan value
 */
async function handlePlanChange(userId, oldPlan, newPlan) {
  if (oldPlan === newPlan) return;

  const wasBasic = oldPlan === PLANS.BASIC;
  const nowBasic = newPlan === PLANS.BASIC;
  const nowPremium = PREMIUM_PLANS.includes(newPlan);
  const wasPremium = PREMIUM_PLANS.includes(oldPlan);

  if (wasBasic && nowPremium) {
    await handleUpgrade(userId);
  } else if (wasPremium && nowBasic) {
    await handleDowngrade(userId);
  }
  // premium-to-premium tier change (pro→advanced) doesn't affect SEO counters
}

module.exports = {
  handleUpgrade,
  handleDowngrade,
  handlePlanChange,
};
