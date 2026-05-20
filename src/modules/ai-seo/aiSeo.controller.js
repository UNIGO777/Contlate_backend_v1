const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const asyncHandler = require("../../core/asyncHandler");
const { PLANS } = require("../../constants/plans");
const aiSeoService = require("./aiSeo.service");
const logger = require("../../core/logger");

/**
 * GET /business/ai-seo/insights
 * Fetch current keyword data + history.
 */
const getInsights = asyncHandler(async (req, res) => {
  const data = await aiSeoService.getInsights(req.business._id);

  if (!data) {
    // Check if GBP is connected — guide user accordingly
    const gbp = await aiSeoService.checkGbpConnected(req.business._id);
    return res.status(200).json(
      new ApiResponse(200, {
        hasData: false,
        gbpConnected: !!gbp,
      }, gbp
        ? "No keyword data yet. Generate your first keyword report."
        : "Connect your Google Business Profile to see keyword insights."
      )
    );
  }

  return res.status(200).json(
    new ApiResponse(200, {
      hasData: true,
      ...data,
    }, "AI SEO insights fetched.")
  );
});

/**
 * POST /business/ai-seo/generate
 * First-time keyword generation (requires GBP connected).
 */
const generate = asyncHandler(async (req, res) => {
  const gbp = await aiSeoService.checkGbpConnected(req.business._id);
  if (!gbp) {
    throw new ApiError(400, "Connect your Google Business Profile first.", {
      code: "GBP_NOT_CONNECTED",
    });
  }

  const data = await aiSeoService.generateKeywords(req.user.id, req.business._id);

  logger.info("[ai-seo] generate complete", {
    businessId: req.business._id,
    keywordCount: data.keywords?.length,
  });

  return res.status(200).json(
    new ApiResponse(200, data, "Keywords generated successfully.")
  );
});

/**
 * POST /business/ai-seo/refresh
 * Monthly rank update (Advanced plan only, same keywords).
 */
const refresh = asyncHandler(async (req, res) => {
  if (req.user.plan !== PLANS.ADVANCED) {
    throw new ApiError(403, "Monthly rank updates require the Advanced plan.");
  }

  const data = await aiSeoService.refreshKeywords(req.business._id);

  return res.status(200).json(
    new ApiResponse(200, data, "Keywords refreshed with updated rank data.")
  );
});

/**
 * PATCH /business/ai-seo/keyword/:index/toggle
 * Toggle workOnIt for a keyword (Advanced plan only).
 */
const toggleKeyword = asyncHandler(async (req, res) => {
  if (req.user.plan !== PLANS.ADVANCED) {
    throw new ApiError(403, "Keyword management requires the Advanced plan.");
  }

  const index = parseInt(req.params.index, 10);
  if (isNaN(index) || index < 0) {
    throw new ApiError(400, "Invalid keyword index.");
  }

  const { workOnIt } = req.body;
  if (typeof workOnIt !== "boolean") {
    throw new ApiError(400, "workOnIt must be a boolean.");
  }

  const data = await aiSeoService.toggleKeywordWorkOnIt(
    req.business._id,
    index,
    workOnIt
  );

  return res.status(200).json(
    new ApiResponse(200, data, `Keyword ${workOnIt ? "enabled" : "disabled"}.`)
  );
});

/**
 * POST /business/ai-seo/new-cycle
 * Start a new 3-month keyword cycle (Advanced plan only).
 */
const newCycle = asyncHandler(async (req, res) => {
  if (req.user.plan !== PLANS.ADVANCED) {
    throw new ApiError(403, "Keyword cycle management requires the Advanced plan.");
  }

  const data = await aiSeoService.startNewCycle(req.user.id, req.business._id);

  return res.status(200).json(
    new ApiResponse(200, data, "New keyword cycle started.")
  );
});

module.exports = {
  getInsights,
  generate,
  refresh,
  toggleKeyword,
  newCycle,
};
