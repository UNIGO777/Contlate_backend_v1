const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const asyncHandler = require("../../core/asyncHandler");
const { ERROR_CODES } = require("../../constants/errorCodes");
const gbpOAuthService = require("../../services/gbpOAuth.service");
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
 * Exchanges code for tokens, fetches accounts/locations, stores encrypted tokens.
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

  // Fetch accounts + locations, save encrypted tokens
  const result = await gbpOAuthService.connectAndFetchLocations(
    req.user.id,
    req.business._id,
    tokenData
  );

  logger.info("[gbp] OAuth connected", {
    businessId: req.business._id,
    accountCount: result.accounts.length,
    locationCount: result.locations.length,
    autoConnected: result.autoConnected,
  });

  return _respondWithLocations(res, req.user.id, req.business._id, result);
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
 * POST /business/gbp/retry-fetch
 * Retry fetching GBP accounts/locations using already-saved tokens.
 * Used when the initial fetch after OAuth failed due to rate limiting.
 */
const retryFetchLocations = asyncHandler(async (req, res) => {
  const result = await gbpOAuthService.fetchLocationsForBusiness(req.business._id);

  if (result.alreadyComplete) {
    return res.status(200).json(
      new ApiResponse(200, {
        connected: true,
        locationName: result.gbpAccount.gbpLocationName,
        needsLocationPicker: false,
      }, "Google Business Profile is already connected.")
    );
  }

  logger.info("[gbp] retry fetch succeeded", {
    businessId: req.business._id,
    locationCount: result.locations.length,
    autoConnected: result.autoConnected,
  });

  return _respondWithLocations(res, req.user.id, req.business._id, result);
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
 * Shared helper — format the response after fetching locations.
 */
function _respondWithLocations(res, userId, businessId, result) {
  if (result.autoConnected) {
    // Auto-trigger AI keyword generation in background
    aiSeoService.generateKeywords(userId, businessId).catch((err) => {
      logger.warn("[gbp] auto AI SEO generation failed", { error: err.message });
    });

    return res.status(200).json(
      new ApiResponse(200, {
        connected: true,
        locationName: result.locations[0].locationName,
        needsLocationPicker: false,
      }, "Google Business Profile connected successfully.")
    );
  }

  return res.status(200).json(
    new ApiResponse(200, {
      connected: true,
      needsLocationPicker: true,
      locations: result.locations.map((loc) => ({
        locationId: loc.locationId,
        locationName: loc.locationName,
        address: loc.address,
        accountName: loc.accountName,
      })),
    }, "Google connected. Please select your business location.")
  );
}

module.exports = {
  getConnectUrl,
  handleCallback,
  selectLocation,
  retryFetchLocations,
  getStatus,
  disconnect,
};
