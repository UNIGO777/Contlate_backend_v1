const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const asyncHandler = require("../../core/asyncHandler");
const { ERROR_CODES } = require("../../constants/errorCodes");
const { PLANS } = require("../../constants/plans");
const seoService = require("../../services/seo.service");
const logger = require("../../core/logger");

const PREMIUM_PLANS = [PLANS.PRO, PLANS.ADVANCED];
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * GET /business/seo/rankings
 * Returns current SEO keyword table for logged-in user's business.
 * req.business is set by checkBusinessMiddleware.
 */
const getRankings = asyncHandler(async (req, res) => {
  const business = req.business;
  const seo = business.seo || {};

  // Auto-trigger SEO research if it has never been started for this business.
  // Covers existing businesses created before the SEO pipeline existed.
  const neverStarted = !seo.seoRefreshStartedAt && (seo.keywords?.length || 0) === 0;
  if (neverStarted && business.category && business.addressDetails?.city) {
    logger.info("[seo] Auto-triggering first-time SEO research via GET /rankings", {
      businessId: business._id.toString(),
    });
    seoService.refreshBusinessSEO(business._id).catch((err) => {
      logger.error("[seo] auto-triggered SEO refresh failed", {
        businessId: business._id.toString(),
        error: err.message,
      });
    });
  }

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        status: seo.status || "pending",
        rankDataAvailable: seo.rankDataAvailable || false,
        lastKeywordRefresh: seo.lastKeywordRefresh || null,
        lastRankRefresh: seo.lastRankRefresh || null,
        seoRefreshStartedAt: seo.seoRefreshStartedAt || null,
        keywordCount: seo.keywords?.length || 0,
        keywords: seo.keywords || [],
        // Group keywords by category/subcategory for frontend display
        groupedKeywords: (() => {
          const kws = seo.keywords || [];
          const groups = {};
          for (const kw of kws) {
            const key = kw.group || business.category || "other";
            if (!groups[key]) {
              groups[key] = {
                group: key,
                groupType: kw.groupType || "category",
                keywords: [],
              };
            }
            groups[key].keywords.push(kw);
          }
          return Object.values(groups);
        })(),
        userPlan: req.user.plan || PLANS.BASIC,
        lastError: seo.status === "error" ? seo.lastError : undefined,
      },
      "SEO rankings fetched."
    )
  );
});

/**
 * POST /business/seo/refresh
 * Manual refresh trigger — rate limited to once per day per business.
 * Premium: refreshes both keywords (if cache expired) and rank.
 * Free: refreshes rank only (one additional refresh allowed).
 */
const refreshRankings = asyncHandler(async (req, res) => {
  const business = req.business;
  const hasKeywords = (business.seo?.keywords?.length || 0) > 0;

  // If business has never had SEO data, run the full refresh (first-time trigger)
  if (!hasKeywords) {
    if (!business.category || !business.addressDetails?.city) {
      throw new ApiError(400, "Complete your business profile first.", {
        code: ERROR_CODES.VALIDATION_FAILED,
      });
    }

    seoService.refreshBusinessSEO(business._id).catch((err) => {
      logger.error("[seo] first-time SEO refresh failed", {
        businessId: business._id,
        error: err.message,
      });
    });

    return res.status(202).json(
      new ApiResponse(202, null, "SEO research started. Your rankings will be ready in ~5 minutes.")
    );
  }

  // Rate limit: once per day per business
  const lastRefresh = business.seo.lastRankRefresh;
  if (lastRefresh && Date.now() - lastRefresh.getTime() < ONE_DAY_MS) {
    throw new ApiError(429, "SEO data was refreshed recently. Try again tomorrow.", {
      code: ERROR_CODES.RATE_LIMITED,
    });
  }

  const userPlan = req.user.plan || PLANS.BASIC;
  const isPremium = PREMIUM_PLANS.includes(userPlan);

  if (isPremium) {
    seoService.refreshBusinessSEO(business._id).catch((err) => {
      logger.error("[seo] manual full refresh failed", {
        businessId: business._id,
        error: err.message,
      });
    });
  } else {
    seoService.refreshRankOnly(business._id).catch((err) => {
      logger.error("[seo] manual rank refresh failed", {
        businessId: business._id,
        error: err.message,
      });
    });
  }

  return res.status(202).json(
    new ApiResponse(202, null, "SEO refresh queued. Data will update shortly.")
  );
});

/**
 * POST /business/seo/regenerate
 * Test mode: wipes existing SEO data + related cache entries, then runs full fresh refresh.
 * No rate limit — meant for development/testing only.
 */
const regenerateSeo = asyncHandler(async (req, res) => {
  const business = req.business;

  if (!business.category || !business.addressDetails?.city) {
    throw new ApiError(400, "Complete your business profile first.", {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }

  const SeoKeywordCache = require("./seoKeywordCache.model");
  const seoCacheService = require("../../services/seoCache.service");

  const category = business.category;
  const city = business.addressDetails.city;
  const subcategories = (business.subcategories || []).filter((s) => s && s.trim());

  // Delete all cache entries for this business (category + subcategory keys)
  const cacheKeysToDelete = [
    seoCacheService.buildCacheKey(category, city),
    ...subcategories.map((s) => seoCacheService.buildSubcategoryCacheKey(s, city)),
  ];

  logger.info("[seo] Regenerate: deleting cache entries", {
    businessId: business._id.toString(),
    cacheKeys: cacheKeysToDelete,
  });

  await SeoKeywordCache.deleteMany({ cacheKey: { $in: cacheKeysToDelete } });

  // Clear business SEO data
  business.seo.keywords = [];
  business.seo.status = "pending";
  business.seo.rankDataAvailable = false;
  business.seo.lastKeywordRefresh = null;
  business.seo.lastRankRefresh = null;
  business.seo.lastError = "";
  business.seo.keywordsFromCache = false;
  await business.save();

  // Fire full refresh
  seoService.refreshBusinessSEO(business._id).catch((err) => {
    logger.error("[seo] regenerate refresh failed", {
      businessId: business._id.toString(),
      error: err.message,
    });
  });

  return res.status(202).json(
    new ApiResponse(202, null, "SEO data cleared and regeneration started.")
  );
});

module.exports = {
  getRankings,
  refreshRankings,
  regenerateSeo,
};
