const Business = require("../modules/business/business.model");
const SeoKeywordCache = require("../modules/seo/seoKeywordCache.model");
const { PLANS } = require("../constants/plans");
const seoCacheService = require("./seoCache.service");
const seoService = require("./seo.service");
const logger = require("../core/logger");

const PREMIUM_PLANS = [PLANS.PRO, PLANS.ADVANCED];

/**
 * Handles when a business changes their category or city after initial onboarding.
 *
 * Step 1 — Decrement old cache entry premiumUserCount (if premium)
 * Step 2 — Clear business SEO data and set to pending
 * Step 3 — Trigger fresh onboarding for new category+city combo
 *
 * @param {Object} business - Mongoose business document
 * @param {string} userPlan - User's current plan (from user.plan)
 * @param {string} oldCategory - Previous category
 * @param {string} oldCity - Previous city
 */
async function handleBusinessCategoryOrCityChange(business, userPlan, oldCategory, oldCity) {
  const newCategory = business.category;
  const newCity = business.addressDetails?.city;

  if (!newCategory || !newCity) {
    logger.warn("[seoBusinessChange] new category or city missing, skipping SEO reset", {
      businessId: business._id,
    });
    return;
  }

  const oldCacheKey = seoCacheService.buildCacheKey(oldCategory, oldCity);
  const newCacheKey = seoCacheService.buildCacheKey(newCategory, newCity);

  // If the cache key hasn't changed, nothing to do
  if (oldCacheKey === newCacheKey) {
    return;
  }

  logger.info("[seoBusinessChange] category/city changed, resetting SEO", {
    businessId: business._id,
    oldCacheKey,
    newCacheKey,
  });

  // Step 1 — Decrement old cache entry if user is premium
  if (PREMIUM_PLANS.includes(userPlan) && oldCategory && oldCity) {
    await SeoKeywordCache.updateOne(
      { cacheKey: oldCacheKey, premiumUserCount: { $gt: 0 } },
      { $inc: { premiumUserCount: -1 } }
    );
    logger.info("[seoBusinessChange] decremented premiumUserCount on old cache", {
      oldCacheKey,
    });
  }

  // Step 2 — Clear business SEO data
  business.seo.keywords = [];
  business.seo.status = "pending";
  business.seo.rankDataAvailable = false;
  business.seo.cacheKey = newCacheKey;
  business.seo.keywordsFromCache = false;
  business.seo.lastError = "";
  business.markModified("seo");
  await business.save();

  // Step 3 — Trigger fresh SEO fetch (fire-and-forget)
  seoService.refreshBusinessSEO(business._id).catch((err) => {
    logger.error("[seoBusinessChange] SEO refresh after change failed", {
      businessId: business._id,
      error: err.message,
    });
  });
}

module.exports = {
  handleBusinessCategoryOrCityChange,
};
