const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const asyncHandler = require("../../core/asyncHandler");
const { ERROR_CODES } = require("../../constants/errorCodes");
const gbpOAuthService = require("../../services/gbpOAuth.service");
const gbpPerformanceService = require("../../services/gbpPerformance.service");
const aiSeoService = require("../ai-seo/aiSeo.service");
const logger = require("../../core/logger");

/**
 * GET /business/gbp/connect-url
 * Returns Google OAuth consent URL for the user to open.
 */
const getConnectUrl = asyncHandler(async (req, res) => {
  const { url } = gbpOAuthService.getConsentUrl(req.user.id);

  return res.status(200).json(
    new ApiResponse(200, { url }, "Redirect the user to this URL to connect Google Business Profile.")
  );
});

/**
 * GET /business/gbp/callback
 * Google redirects here after the user approves or denies.
 * Exchanges code for tokens, saves them, and queues a background sync job.
 * Returns immediately — does NOT call Google Business APIs in-request.
 */
const handleCallback = asyncHandler(async (req, res) => {
  const { code, state, error: oauthError, error_description } = req.query;

  // Handle user denial or Google-side errors
  if (oauthError) {
    const message = oauthError === "access_denied"
      ? "Google connection was cancelled. You can try again anytime."
      : error_description || `Google OAuth error: ${oauthError}`;

    logger.warn("[gbp] OAuth callback error", { error: oauthError, error_description });

    throw new ApiError(400, message, { code: ERROR_CODES.GBP_OAUTH_FAILED });
  }

  if (!code || !state) {
    logger.warn("[gbp] OAuth callback missing params", {
      hasCode: !!code,
      hasState: !!state,
    });
    throw new ApiError(400, "Missing OAuth code or state.", {
      code: ERROR_CODES.GBP_OAUTH_FAILED,
    });
  }

  // Verify CSRF state and extract userId
  const { userId } = gbpOAuthService.verifyState(state);

  // Ensure the state userId matches the authenticated user
  if (userId !== req.user.id) {
    throw new ApiError(400, "OAuth state mismatch. Please try again.", {
      code: ERROR_CODES.GBP_OAUTH_FAILED,
    });
  }

  // Exchange code for tokens
  const tokenData = await gbpOAuthService.exchangeCode(code);

  // Save tokens and queue background sync (returns immediately)
  await gbpOAuthService.connectAndSaveTokens(
    req.user.id,
    req.business._id,
    tokenData
  );

  logger.info("[gbp] OAuth tokens saved, sync queued", {
    businessId: req.business._id,
  });

  return res.status(200).json(
    new ApiResponse(200, {
      connected: true,
      syncing: true,
    }, "Google account connected. Fetching your business locations in the background...")
  );
});

/**
 * POST /business/gbp/retry-fetch
 * Re-queue a GBP sync job for a business whose initial sync failed.
 */
const retryFetchLocations = asyncHandler(async (req, res) => {
  const result = await gbpOAuthService.retrySync(req.business._id);

  if (result.alreadyComplete) {
    return res.status(200).json(
      new ApiResponse(200, {
        connected: true,
        syncing: false,
        locationName: result.gbpAccount.gbpLocationName,
      }, "Google Business Profile is already connected.")
    );
  }

  if (result.alreadySyncing) {
    return res.status(200).json(
      new ApiResponse(200, {
        connected: true,
        syncing: true,
      }, "Sync is already in progress. Please wait...")
    );
  }

  logger.info("[gbp] retry sync queued", { businessId: req.business._id });

  return res.status(200).json(
    new ApiResponse(200, {
      connected: true,
      syncing: true,
    }, "Retrying location fetch in the background...")
  );
});

/**
 * POST /business/gbp/select-location
 * User selects which GBP location to connect (when they have multiple).
 */
const selectLocation = asyncHandler(async (req, res) => {
  const { locationId, locationName, accountId, accountName } = req.body;

  if (!locationId || typeof locationId !== "string") {
    throw new ApiError(400, "locationId is required.", {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }

  const gbpAccount = await gbpOAuthService.selectLocation(
    req.business._id,
    locationId.trim(),
    { locationName, accountId, accountName }
  );

  logger.info("[gbp] location selected", {
    businessId: req.business._id,
    locationId: gbpAccount.gbpLocationId,
    locationName: gbpAccount.gbpLocationName,
  });

  // Auto-trigger AI keyword generation in background
  aiSeoService.generateKeywords(req.user.id, req.business._id).catch((err) => {
    logger.warn("[gbp] auto AI SEO generation after location select failed", { error: err.message });
  });

  return res.status(200).json(
    new ApiResponse(200, {
      locationName: gbpAccount.gbpLocationName,
      accountName: gbpAccount.gbpAccountName,
    }, "Business location connected successfully.")
  );
});

/**
 * GET /business/gbp/status
 * Returns whether GBP is connected for this business + connected location name.
 */
const getStatus = asyncHandler(async (req, res) => {
  const status = await gbpOAuthService.getStatus(req.business._id);

  return res.status(200).json(
    new ApiResponse(200, status, "GBP connection status.")
  );
});

/**
 * DELETE /business/gbp/disconnect
 * Removes GBP tokens — user can reconnect anytime.
 */
const disconnect = asyncHandler(async (req, res) => {
  const removed = await gbpOAuthService.disconnect(req.business._id);

  logger.info("[gbp] disconnected", {
    businessId: req.business._id,
    wasConnected: removed,
  });

  return res.status(200).json(
    new ApiResponse(200, { disconnected: true }, "Google Business Profile disconnected.")
  );
});

/**
 * GET /business/gbp/insights
 * Cached Google Business Profile performance metrics.
 *
 * Reads come from our own cache by default — Google is only called when the
 * cache has expired. `?refresh=1` asks for an early refresh but is still
 * floored by GBP_INSIGHTS_MIN_REFRESH_MINUTES to protect the daily quota.
 */
const getInsights = asyncHandler(async (req, res) => {
  const force = req.query.refresh === "1" || req.query.refresh === "true";
  const data = await gbpPerformanceService.getInsights(req.business._id, { force });

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        rangeStart: data.rangeStart,
        rangeEnd: data.rangeEnd,
        totals: data.totals,
        previousTotals: data.previousTotals,
        deltaPct: data.deltaPct,
        daily: data.daily,
        fetchedAt: data.fetchedAt,
        cacheHit: !!data.cacheHit,
        stale: !!data.stale,
        throttled: !!data.throttled,
      },
      "Google Business Profile performance."
    )
  );
});

module.exports = {
  getConnectUrl,
  getInsights,
  handleCallback,
  selectLocation,
  retryFetchLocations,
  getStatus,
  disconnect,
};
