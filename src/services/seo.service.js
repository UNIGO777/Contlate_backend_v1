const Business = require("../modules/business/business.model");
const User = require("../modules/user/user.model");
const SeoKeywordCache = require("../modules/seo/seoKeywordCache.model");
const { PLANS } = require("../constants/plans");
const googleTrendsService = require("./googleTrends.service");
const dataForSeoService = require("./dataForSeo.service");
const seoCacheService = require("./seoCache.service");
const logger = require("../core/logger");

const PREMIUM_PLANS = [PLANS.PRO, PLANS.ADVANCED];

/**
 * Main SEO orchestrator.
 * Applies all Smart Rules in sequence to fetch/cache/reuse keyword and rank data.
 *
 * @param {string|ObjectId} businessId
 */
async function refreshBusinessSEO(businessId) {
  // Step 0 — Load business + user
  const business = await Business.findById(businessId);
  if (!business) {
    throw new Error(`Business not found: ${businessId}`);
  }

  const user = await User.findById(business.userId);
  if (!user) {
    throw new Error(`User not found for business: ${businessId}`);
  }

  const userPlan = user.plan; // read at runtime, never stored in business.seo
  const category = business.category;
  const city = business.addressDetails?.city;
  const state = business.addressDetails?.state;

  if (!category || !city) {
    throw new Error(
      `Business ${businessId} missing category or city — cannot fetch SEO data`
    );
  }

  const cacheKey = seoCacheService.buildCacheKey(category, city);
  const locationName = dataForSeoService.buildLocationName(city, state);

  // Track whether this business was already counted for premiumUserCount (Bug 4 fix)
  // Must check BEFORE resetting status to "pending"
  const alreadyCounted =
    business.seo.keywordsFromCache === true ||
    (business.seo.status === "ready" && business.seo.keywords.length > 0);

  // Set initial state
  business.seo.cacheKey = cacheKey;
  business.seo.locationName = locationName;
  business.seo.status = "pending";
  business.seo.lastError = "";
  await business.save();

  try {
    // Step 1 — Keywords from cache or fresh fetch (Rules 1 + 2)
    const cachedEntry = await seoCacheService.checkCache(cacheKey);

    if (cachedEntry) {
      // Cache hit — copy keywords instantly, zero API cost
      await seoCacheService.copyToBusinessSeo(
        business,
        cachedEntry,
        userPlan,
        alreadyCounted
      );
      logger.info(`Cache hit for [${cacheKey}], skipped keyword API call`, {
        businessId,
      });
    } else {
      // Cache miss — fetch fresh keywords
      logger.info(`Cache miss for [${cacheKey}], fetching fresh data`, {
        businessId,
      });

      // Get keywords from Google Trends (with seed template fallback)
      // Bug 5 fix: pass state to getKeywords
      const trendKeywords = await googleTrendsService.getKeywords(
        category,
        city,
        business.services,
        business.subcategories,
        state
      );

      // Get search volumes from DataForSEO
      const keywordStrings = trendKeywords.map((k) => k.keyword);
      const volumeData = await dataForSeoService.getKeywordVolumes(
        keywordStrings,
        locationName
      );

      // Merge trend data with volume data
      const mergedKeywords = trendKeywords.map((trend) => {
        const volume = volumeData.find(
          (v) => v.keyword.toLowerCase() === trend.keyword.toLowerCase()
        );
        return {
          keyword: trend.keyword,
          monthlyVolume: volume?.monthlyVolume || 0,
          competition: volume?.competition || null,
          trendValue: trend.trendValue,
          isRising: trend.isRising,
          source: trend.source || null,
        };
      });

      // Save to shared cache
      await seoCacheService.updateCache(cacheKey, {
        category,
        city,
        state,
        locationName,
        keywords: mergedKeywords,
      });

      // Copy to business
      business.seo.keywords = mergedKeywords.map((kw) => ({
        ...kw,
        mapsRank: null,
        topBusiness: null,
        updatedAt: new Date(),
      }));
      business.seo.keywordsFromCache = false;
      business.seo.lastKeywordRefresh = new Date();
      business.seo.status = "keywords_ready";
      await business.save();

      // If premium and not already counted, increment counter (Bug 4 fix)
      if (PREMIUM_PLANS.includes(userPlan) && !alreadyCounted) {
        await SeoKeywordCache.updateOne(
          { cacheKey },
          { $inc: { premiumUserCount: 1 } }
        );
      }
    }

    // Step 2 — Rank fetch for ALL users (Rule 4 updated)
    // Always run on first signup — free or premium
    const keywordsForRank = business.seo.keywords.map((k) => k.keyword);
    const rankings = await dataForSeoService.getLocalRankings(
      keywordsForRank,
      locationName,
      business.businessName
    );

    // Merge rank positions into business.seo.keywords
    for (const rank of rankings) {
      const kwEntry = business.seo.keywords.find(
        (k) => k.keyword.toLowerCase() === rank.keyword.toLowerCase()
      );
      if (kwEntry) {
        kwEntry.mapsRank = rank.mapsRank;
        kwEntry.topBusiness = rank.topBusiness;
        kwEntry.updatedAt = new Date();
      }
    }

    business.seo.rankDataAvailable = true;
    business.seo.lastRankRefresh = new Date();
    business.seo.status = "ready";
    business.seo.lastError = "";
    await business.save();

    logger.info("SEO refresh complete", {
      businessId,
      cacheKey,
      plan: userPlan,
      keywordCount: business.seo.keywords.length,
      rankedCount: business.seo.keywords.filter((k) => k.mapsRank !== null).length,
    });

    return business.seo;
  } catch (err) {
    // Mark business as error state
    business.seo.status = "error";
    business.seo.lastError = err.message;
    await business.save();

    logger.error("SEO refresh failed", {
      businessId,
      cacheKey,
      error: err.message,
    });

    throw err;
  }
}

/**
 * Refresh only rank data for a business (used by weekly cron for premium users).
 */
async function refreshRankOnly(businessId) {
  const business = await Business.findById(businessId);
  if (!business) {
    throw new Error(`Business not found: ${businessId}`);
  }

  if (!business.seo.keywords.length) {
    throw new Error(`Business ${businessId} has no keywords — run full refresh first`);
  }

  const locationName = business.seo.locationName;
  const keywordsForRank = business.seo.keywords.map((k) => k.keyword);

  try {
    const rankings = await dataForSeoService.getLocalRankings(
      keywordsForRank,
      locationName,
      business.businessName
    );

    for (const rank of rankings) {
      const kwEntry = business.seo.keywords.find(
        (k) => k.keyword.toLowerCase() === rank.keyword.toLowerCase()
      );
      if (kwEntry) {
        kwEntry.mapsRank = rank.mapsRank;
        kwEntry.topBusiness = rank.topBusiness;
        kwEntry.updatedAt = new Date();
      }
    }

    business.seo.rankDataAvailable = true;
    business.seo.lastRankRefresh = new Date();
    business.seo.status = "ready";
    business.seo.lastError = "";
    await business.save();

    logger.info("Rank-only refresh complete", {
      businessId,
      rankedCount: business.seo.keywords.filter((k) => k.mapsRank !== null).length,
    });

    return business.seo;
  } catch (err) {
    business.seo.status = "error";
    business.seo.lastError = err.message;
    await business.save();

    logger.error("Rank-only refresh failed", {
      businessId,
      error: err.message,
    });

    throw err;
  }
}

module.exports = {
  refreshBusinessSEO,
  refreshRankOnly,
};
