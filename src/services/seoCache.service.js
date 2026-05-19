const SeoKeywordCache = require("../modules/seo/seoKeywordCache.model");
const { PLANS } = require("../constants/plans");
const logger = require("../core/logger");

const CACHE_TTL_DAYS = 30;

/**
 * Build a cache key from category and city.
 * Format: "category:dentist|city:bhopal"
 */
function buildCacheKey(category, city) {
  return `category:${category.toLowerCase().trim()}|city:${city.toLowerCase().trim()}`;
}

/**
 * Build a cache key for a subcategory.
 * Format: "subcategory:teeth whitening|city:bhopal"
 */
function buildSubcategoryCacheKey(subcategory, city) {
  return `subcategory:${subcategory.toLowerCase().trim()}|city:${city.toLowerCase().trim()}`;
}

/**
 * Check cache for existing keyword data.
 * Returns cached entry if exists and not expired, null otherwise. (Rule 1)
 */
async function checkCache(cacheKey) {
  const entry = await SeoKeywordCache.findOne({ cacheKey });

  if (!entry) {
    logger.info("SEO cache miss — no entry", { cacheKey });
    return null;
  }

  if (entry.expiresAt <= new Date()) {
    logger.info("SEO cache miss — expired", {
      cacheKey,
      expiresAt: entry.expiresAt,
    });
    return null;
  }

  logger.info("SEO cache hit", {
    cacheKey,
    keywordCount: entry.keywords.length,
    expiresAt: entry.expiresAt,
  });

  return entry;
}

/**
 * Copy cached keywords to a business's SEO data. (Rule 2)
 * Does NOT copy rank data — ranks are per-business.
 *
 * @param {Object} business - Mongoose business document
 * @param {Object} cachedEntry - SeoKeywordCache document
 * @param {string} userPlan - User's current plan (from user.plan)
 * @param {boolean} alreadyCounted - If true, skip premiumUserCount increment (Bug 4 fix)
 */
async function copyToBusinessSeo(business, cachedEntry, userPlan, alreadyCounted = false) {
  const PREMIUM_PLANS = [PLANS.PRO, PLANS.ADVANCED];

  // Copy keywords without rank data (preserve group metadata)
  business.seo.keywords = cachedEntry.keywords.map((kw) => ({
    keyword: kw.keyword,
    monthlyVolume: kw.monthlyVolume,
    competition: kw.competition,
    trendValue: kw.trendValue,
    isRising: kw.isRising,
    source: kw.source || null,
    group: kw.group || null,
    groupType: kw.groupType || null,
    mapsRank: null,
    topBusiness: null,
    updatedAt: new Date(),
  }));

  business.seo.keywordsFromCache = true;
  business.seo.cacheKey = cachedEntry.cacheKey;
  business.seo.locationName = cachedEntry.locationName;
  business.seo.lastKeywordRefresh = cachedEntry.lastRefreshed;
  business.seo.status = "keywords_ready";

  await business.save();

  // Update cache entry usage tracking
  const updateOps = { lastUsedAt: new Date() };

  if (PREMIUM_PLANS.includes(userPlan) && !alreadyCounted) {
    await SeoKeywordCache.updateOne(
      { _id: cachedEntry._id },
      { $set: updateOps, $inc: { premiumUserCount: 1 } }
    );
  } else {
    await SeoKeywordCache.updateOne(
      { _id: cachedEntry._id },
      { $set: updateOps }
    );
  }

  logger.info("Copied cached keywords to business", {
    businessId: business._id,
    cacheKey: cachedEntry.cacheKey,
    keywordCount: cachedEntry.keywords.length,
    isPremium: PREMIUM_PLANS.includes(userPlan),
  });
}

/**
 * Create or update a cache entry with fresh keyword data.
 * Preserves premiumUserCount across updates.
 */
async function updateCache(cacheKey, { category, city, state, locationName, keywords, type = "category", subcategory = "" }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const result = await SeoKeywordCache.findOneAndUpdate(
    { cacheKey },
    {
      $set: {
        type,
        category,
        subcategory,
        city,
        state,
        locationName,
        keywords,
        lastRefreshed: now,
        expiresAt,
        lastUsedAt: now,
      },
      $setOnInsert: {
        premiumUserCount: 0,
      },
    },
    { upsert: true, new: true }
  );

  logger.info("SEO cache updated", {
    cacheKey,
    keywordCount: keywords.length,
    expiresAt,
    premiumUserCount: result.premiumUserCount,
  });

  return result;
}

module.exports = {
  buildCacheKey,
  buildSubcategoryCacheKey,
  checkCache,
  copyToBusinessSeo,
  updateCache,
  CACHE_TTL_DAYS,
};
