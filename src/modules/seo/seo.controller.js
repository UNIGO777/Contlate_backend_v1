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

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        status: seo.status || "pending",
        rankDataAvailable: seo.rankDataAvailable || false,
        lastKeywordRefresh: seo.lastKeywordRefresh || null,
        lastRankRefresh: seo.lastRankRefresh || null,
        keywordCount: seo.keywords?.length || 0,
        keywords: seo.keywords || [],
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

  if (!business.seo?.keywords?.length) {
    throw new ApiError(400, "No SEO data to refresh. Complete onboarding first.", {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
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
    // Premium: full refresh (keywords if cache expired + rank)
    seoService.refreshBusinessSEO(business._id).catch((err) => {
      logger.error("[seo] manual full refresh failed", {
        businessId: business._id,
        error: err.message,
      });
    });
  } else {
    // Free: rank-only refresh
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

module.exports = {
  getRankings,
  refreshRankings,
};
