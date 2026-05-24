const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const asyncHandler = require("../../core/asyncHandler");
const { SOCIAL_PLATFORMS } = require("../../constants/socialPlatforms");
const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");
const { CONNECTION_STATES } = require("../../constants/connectionStates");
const { CONNECTION_MESSAGES } = require("../../constants/connectionMessages");
const { encrypt } = require("../../core/tokenEncryption");
const metaService = require("../../services/meta.service");
const SocialAccount = require("./social.model");

/**
 * GET /social/meta/connection-status
 * Detect the user's current Meta connection state and return
 * user-friendly guidance for the next action.
 *
 * Query: ?forceRefresh=true — bypass the 5-min cache
 */
const getConnectionStatus = asyncHandler(async (req, res) => {
  const forceRefresh = req.query.forceRefresh === "true";

  const detection = await metaService.detectConnectionState(req.user._id, {
    forceRefresh,
  });

  const message = CONNECTION_MESSAGES[detection.state] || CONNECTION_MESSAGES[CONNECTION_STATES.DETECTION_ERROR];

  const response = {
    state: detection.state,
    cached: detection.cached,
    title: message.title,
    description: message.description,
    actionLabel: message.actionLabel,
    actionType: message.actionType,
    pages: detection.pages || [],
    details: detection.details || {},
  };

  // Add OAuth URL for states that need it
  if (
    detection.state === CONNECTION_STATES.NO_FACEBOOK_LOGIN ||
    detection.state === CONNECTION_STATES.TOKEN_EXPIRED
  ) {
    const { url } = metaService.getAuthorizeUrl(req.user._id.toString(), {
      scopeType: "connect",
    });
    response.oauthUrl = url;
  }

  if (detection.state === CONNECTION_STATES.PERMISSIONS_MISSING) {
    const missingScopes = detection.details?.missingScopes || [];
    const { url } = metaService.getAuthorizeUrl(req.user._id.toString(), {
      scopeType: "missing",
      missingScopes,
    });
    response.oauthUrl = url;
    response.missingScopes = missingScopes;
  }

  // Add actionUrl for external-link states
  if (message.actionUrl) {
    response.actionUrl = message.actionUrl;
  }

  // Add secondary action and steps if present
  if (message.secondaryAction) {
    response.secondaryAction = message.secondaryAction;
  }
  if (message.steps) {
    response.steps = message.steps;
  }

  // For PAGE_EXISTS_NO_IG, generate per-page action URLs
  if (detection.state === CONNECTION_STATES.PAGE_EXISTS_NO_IG && detection.pages?.length > 0) {
    const firstPage = detection.pages.find((p) => p.instagram?.linked === false);
    if (firstPage) {
      response.actionUrl = `https://www.facebook.com/${firstPage.pageId}/settings/?tab=instagram_management`;
    }
  }

  // Add showRefreshButton for states where user performs an external action
  const refreshStates = [
    CONNECTION_STATES.NO_PAGE,
    CONNECTION_STATES.PAGE_EXISTS_NO_IG,
    CONNECTION_STATES.IG_PERSONAL,
    CONNECTION_STATES.RATE_LIMITED,
    CONNECTION_STATES.DETECTION_ERROR,
  ];
  response.showRefreshButton = refreshStates.includes(detection.state);

  return res.status(200).json(
    new ApiResponse(200, response, "Connection status fetched.")
  );
});

/**
 * GET /social/meta/pages
 * Fetch the user's Facebook Pages from Graph API (live, not cached).
 * Requires a stored userAccessToken from a prior OAuth exchange.
 */
const listPages = asyncHandler(async (req, res) => {
  // Find any Meta account for this user that has a userAccessToken
  const account = await SocialAccount.findOne({
    userId: req.user._id,
    platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
    status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
    userAccessToken: { $ne: "" },
  });

  if (!account) {
    throw new ApiError(400, "No connected Meta account found. Please connect via OAuth first.");
  }

  const userToken = metaService.decryptToken(account.userAccessToken);
  const pages = await metaService.listManagedPages(userToken);

  // Determine setup issues
  const setupIssues = [];
  if (pages.length === 0) {
    setupIssues.push("no_pages");
  }

  return res.status(200).json(
    new ApiResponse(200, {
      pages: pages.map((p) => ({
        pageId: p.pageId,
        pageName: p.pageName,
        instagramAccountId: p.instagramAccountId || null,
        instagramUsername: p.instagramUsername || null,
        hasInstagram: !!p.instagramAccountId,
      })),
      setupIssues,
    }, "Pages fetched.")
  );
});

/**
 * POST /social/meta/select-pages
 * User selects which Pages to connect after OAuth.
 * Body: { pageIds: ["123", "456"], userAccessToken?: string }
 *
 * The userAccessToken is passed from the OAuth exchange response stored
 * temporarily on the frontend, OR we re-read it from an existing account.
 */
const selectPages = asyncHandler(async (req, res) => {
  const { pageIds } = req.body;

  if (!Array.isArray(pageIds) || pageIds.length === 0) {
    throw new ApiError(400, "Select at least one page.");
  }

  // Find the stored user-level token
  const existingAccount = await SocialAccount.findOne({
    userId: req.user._id,
    platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
    userAccessToken: { $ne: "" },
  });

  if (!existingAccount) {
    throw new ApiError(400, "No Meta token found. Please reconnect via OAuth.");
  }

  const userToken = metaService.decryptToken(existingAccount.userAccessToken);
  const allPages = await metaService.listManagedPages(userToken);

  // Filter to only selected pages
  const selectedPages = allPages.filter((p) => pageIds.includes(p.pageId));

  if (selectedPages.length === 0) {
    throw new ApiError(400, "None of the selected pages were found.");
  }

  const Business = require("../business/business.model");
  const business = await Business.findOne({ userId: req.user._id });
  if (!business) {
    throw new ApiError(400, "Connect a business profile first.");
  }

  const tokenExpiresAt = existingAccount.tokenExpiresAt;
  const encryptedUserToken = existingAccount.userAccessToken; // already encrypted

  // Duplicate page detection: check if any selected page is already connected
  // by a DIFFERENT user in the same business
  const allSelectedAccountIds = selectedPages.map((p) => p.pageId);
  const allSelectedIgIds = selectedPages
    .filter((p) => p.instagramAccountId)
    .map((p) => p.instagramAccountId);
  const conflicting = await SocialAccount.find({
    businessId: business._id,
    userId: { $ne: req.user._id },
    platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
    accountId: { $in: [...allSelectedAccountIds, ...allSelectedIgIds] },
    status: { $ne: SOCIAL_ACCOUNT_STATUS.DISCONNECTED },
  }).lean();

  if (conflicting.length > 0) {
    const conflictNames = conflicting.map((c) => c.accountName).join(", ");
    throw new ApiError(
      409,
      `These accounts are already connected by another team member: ${conflictNames}. Disconnect them first.`
    );
  }

  // Carry forward grantedScopes from the existing account
  const existingScopes = existingAccount.grantedScopes || [];
  const existingScopeType = existingAccount.oauthScopeType || "full";

  const upserts = [];
  for (const page of selectedPages) {
    const encryptedPageToken = encrypt(page.pageAccessToken);

    upserts.push(
      SocialAccount.findOneAndUpdate(
        { userId: req.user._id, platform: SOCIAL_PLATFORMS.FACEBOOK, accountId: page.pageId },
        {
          $set: {
            userId: req.user._id,
            businessId: business._id,
            platform: SOCIAL_PLATFORMS.FACEBOOK,
            accountName: page.pageName,
            accountId: page.pageId,
            accessToken: encryptedPageToken,
            userAccessToken: encryptedUserToken,
            pageId: page.pageId,
            tokenExpiresAt,
            tokenVersion: 1,
            status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
            healthStatus: "healthy",
            disconnectReason: null,
            grantedScopes: existingScopes,
            oauthScopeType: existingScopeType,
            pendingExpiresAt: null,
            lastSyncedAt: new Date(),
            lastTokenRefreshedAt: new Date(),
          },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
      )
    );

    if (page.instagramAccountId) {
      upserts.push(
        SocialAccount.findOneAndUpdate(
          { userId: req.user._id, platform: SOCIAL_PLATFORMS.INSTAGRAM, accountId: page.instagramAccountId },
          {
            $set: {
              userId: req.user._id,
              businessId: business._id,
              platform: SOCIAL_PLATFORMS.INSTAGRAM,
              accountName: page.instagramUsername || page.pageName,
              accountId: page.instagramAccountId,
              accessToken: encryptedPageToken,
              userAccessToken: encryptedUserToken,
              pageId: page.pageId,
              tokenExpiresAt,
              tokenVersion: 1,
              status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
              healthStatus: "healthy",
              disconnectReason: null,
              grantedScopes: existingScopes,
              oauthScopeType: existingScopeType,
              pendingExpiresAt: null,
              lastSyncedAt: new Date(),
              lastTokenRefreshedAt: new Date(),
            },
          },
          { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
        )
      );
    }
  }

  // Disconnect pages that were NOT selected (if user previously had more)
  const selectedAccountIds = selectedPages.map((p) => p.pageId);
  const selectedIgIds = selectedPages
    .filter((p) => p.instagramAccountId)
    .map((p) => p.instagramAccountId);
  const allSelectedIds = [...selectedAccountIds, ...selectedIgIds];

  await SocialAccount.updateMany(
    {
      userId: req.user._id,
      platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
      accountId: { $nin: allSelectedIds },
      status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
    },
    {
      $set: {
        status: SOCIAL_ACCOUNT_STATUS.DISCONNECTED,
        accessToken: "",
        userAccessToken: "",
        disconnectReason: "user_action",
      },
    }
  );

  const accounts = await Promise.all(upserts);

  // Clean up pending_setup placeholders
  await SocialAccount.deleteMany({
    userId: req.user._id,
    status: SOCIAL_ACCOUNT_STATUS.PENDING_SETUP,
  });

  // Invalidate connection state cache
  metaService.invalidateStateCache(req.user._id);

  // Subscribe selected pages to webhooks (fire-and-forget)
  for (const page of selectedPages) {
    metaService.subscribePageToWebhooks(page.pageId, page.pageAccessToken).catch(() => {});
  }

  // Auto-resume paused schedules for reconnected accounts
  const { resumePausedSchedules } = require("../../jobs/postPublisher.job");
  for (const acct of accounts) {
    resumePausedSchedules(acct._id).catch(() => {});
  }

  return res.status(200).json(
    new ApiResponse(200, {
      connected: accounts.length,
      accounts: accounts.map((a) => ({
        id: a._id.toString(),
        platform: a.platform,
        accountName: a.accountName,
        accountId: a.accountId,
      })),
    }, "Selected pages connected.")
  );
});

/**
 * GET /social/meta/instagram-status/:pageId
 * Check if a specific Page has a linked Instagram Business account.
 */
const getInstagramStatus = asyncHandler(async (req, res) => {
  const { pageId } = req.params;

  const account = await SocialAccount.findOne({
    userId: req.user._id,
    platform: SOCIAL_PLATFORMS.FACEBOOK,
    accountId: pageId,
    status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
  });

  if (!account) {
    throw new ApiError(404, "Page not found or not connected.");
  }

  const pageToken = metaService.decryptToken(account.accessToken);

  let igStatus = { linked: false, accountId: null, username: null, accountType: null };

  try {
    const data = await metaService.graphFetch(`/${pageId}`, {
      searchParams: {
        fields: "instagram_business_account{id,username,account_type}",
        access_token: pageToken,
      },
    });

    if (data.instagram_business_account) {
      igStatus = {
        linked: true,
        accountId: data.instagram_business_account.id,
        username: data.instagram_business_account.username || null,
        accountType: data.instagram_business_account.account_type || null,
      };
    }
  } catch {
    // Page might not have IG linked — that's fine
  }

  return res.status(200).json(
    new ApiResponse(200, { pageId, instagram: igStatus }, "Instagram status fetched.")
  );
});

/**
 * GET /social/meta/permissions
 * Check which permissions were granted for the user's Meta token.
 * Returns actionable response with publish capability flags and reauth URL.
 */
const checkPermissions = asyncHandler(async (req, res) => {
  const account = await SocialAccount.findOne({
    userId: req.user._id,
    platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
    status: { $in: [SOCIAL_ACCOUNT_STATUS.CONNECTED, SOCIAL_ACCOUNT_STATUS.PENDING_SETUP] },
    userAccessToken: { $ne: "" },
  });

  if (!account) {
    throw new ApiError(400, "No connected Meta account found.");
  }

  const userToken = metaService.decryptToken(account.userAccessToken);
  const { granted, declined, missing } = await metaService.detectMissingScopes(userToken);

  // Update cached grantedScopes in DB
  await SocialAccount.updateMany(
    {
      userId: req.user._id,
      platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
      status: { $ne: SOCIAL_ACCOUNT_STATUS.DISCONNECTED },
    },
    { $set: { grantedScopes: granted } }
  );

  const canPublishFacebook = granted.includes("pages_manage_posts");
  const canPublishInstagram =
    granted.includes("instagram_basic") &&
    granted.includes("instagram_content_publish");

  const allGranted = missing.length === 0 && declined.length === 0;

  const response = {
    allGranted,
    granted,
    missing,
    declined,
    canPublishFacebook,
    canPublishInstagram,
  };

  // Add reauth URL if scopes are missing or declined
  const needsReauth = [...missing, ...declined];
  if (needsReauth.length > 0) {
    const { url } = metaService.getAuthorizeUrl(req.user._id.toString(), {
      scopeType: "missing",
      missingScopes: needsReauth,
    });
    response.action = "Approve additional permissions to enable publishing.";
    response.reauthUrl = url;
  }

  return res.status(200).json(
    new ApiResponse(200, response, "Permissions checked.")
  );
});

/**
 * POST /social/meta/refresh-token/:socialAccountId
 * Force-refresh the access token for a specific Meta account.
 * Useful when the user reports a problem or after an expired-token error.
 */
const refreshToken = asyncHandler(async (req, res) => {
  const { socialAccountId } = req.params;

  const account = await SocialAccount.findOne({
    _id: socialAccountId,
    userId: req.user._id,
    platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
  });

  if (!account) {
    throw new ApiError(404, "Social account not found.");
  }

  // Need a userAccessToken to refresh with
  const rawToken = account.userAccessToken || account.accessToken;
  if (!rawToken) {
    throw new ApiError(400, "No token available to refresh. Please reconnect this account.");
  }

  let currentToken;
  try {
    currentToken = metaService.decryptToken(rawToken);
  } catch {
    throw new ApiError(400, "Token is invalid. Please reconnect this account.");
  }

  let refreshed;
  try {
    refreshed = await metaService.exchangeForLongLivedToken(currentToken);
  } catch (err) {
    // Token is fully revoked — mark account as expired
    if (err.isAuthError || err.metaCode === 190) {
      await SocialAccount.findByIdAndUpdate(account._id, {
        $set: {
          status: SOCIAL_ACCOUNT_STATUS.EXPIRED,
          healthStatus: "critical",
          disconnectReason: "token_expired",
        },
      });
      throw new ApiError(401, "Token has expired or been revoked. Please reconnect your account.");
    }
    throw new ApiError(502, err.message || "Failed to refresh token.");
  }

  const tokenExpiresAt = refreshed.expiresIn
    ? new Date(Date.now() + refreshed.expiresIn * 1000)
    : null;

  const encryptedNewToken = encrypt(refreshed.accessToken);

  // Re-fetch page token if this is a Facebook account
  let newPageToken = account.accessToken;
  if (account.platform === SOCIAL_PLATFORMS.FACEBOOK && account.pageId) {
    try {
      const pages = await metaService.listManagedPages(refreshed.accessToken);
      const matched = pages.find((p) => p.pageId === account.accountId);
      if (matched) newPageToken = encrypt(matched.pageAccessToken);
    } catch {
      // Proceed with existing page token — not fatal
    }
  }

  // Optimistic locking: only update if tokenVersion hasn't changed
  const currentVersion = account.tokenVersion || 0;
  const updateResult = await SocialAccount.findOneAndUpdate(
    { _id: account._id, tokenVersion: currentVersion },
    {
      $set: {
        userAccessToken: encryptedNewToken,
        accessToken: newPageToken,
        tokenExpiresAt,
        lastTokenRefreshedAt: new Date(),
        status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
        healthStatus: "healthy",
        disconnectReason: null,
      },
      $inc: { tokenVersion: 1 },
    }
  );

  if (!updateResult) {
    // Another process refreshed it — the token is fresh, just return success
    return res.status(200).json(
      new ApiResponse(200, {
        accountId: account._id.toString(),
        tokenExpiresAt: null,
        refreshedAt: new Date(),
        note: "Token was already refreshed by another process.",
      }, "Token is already up to date.")
    );
  }

  // Sync linked Instagram account's tokens if this is a Facebook account
  if (account.platform === SOCIAL_PLATFORMS.FACEBOOK && account.pageId) {
    await SocialAccount.updateMany(
      {
        pageId: account.pageId,
        platform: SOCIAL_PLATFORMS.INSTAGRAM,
        userId: req.user._id,
      },
      {
        $set: {
          userAccessToken: encryptedNewToken,
          accessToken: newPageToken,
          tokenExpiresAt,
          lastTokenRefreshedAt: new Date(),
          status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
          healthStatus: "healthy",
          disconnectReason: null,
        },
        $inc: { tokenVersion: 1 },
      }
    );
  }

  // Invalidate connection state cache after refresh
  metaService.invalidateStateCache(req.user._id);

  // Auto-resume paused schedules for this account (and linked IG)
  const { resumePausedSchedules } = require("../../jobs/postPublisher.job");
  resumePausedSchedules(account._id).catch(() => {});
  if (account.platform === SOCIAL_PLATFORMS.FACEBOOK && account.pageId) {
    // Also resume for linked IG accounts
    SocialAccount.find({
      pageId: account.pageId,
      platform: SOCIAL_PLATFORMS.INSTAGRAM,
      userId: req.user._id,
    }).lean().then((igAccounts) => {
      for (const ig of igAccounts) {
        resumePausedSchedules(ig._id).catch(() => {});
      }
    }).catch(() => {});
  }

  return res.status(200).json(
    new ApiResponse(200, {
      accountId: account._id.toString(),
      tokenExpiresAt,
      refreshedAt: new Date(),
    }, "Token refreshed successfully.")
  );
});

/**
 * POST /social/meta/reconnect/:socialAccountId
 * Smart reconnect: tries silent token refresh first, falls back to OAuth re-auth.
 *
 * Response:
 *   { reconnected: true }                  — silent refresh succeeded
 *   { reconnected: false, oauthUrl: "..." } — user must complete OAuth
 */
const reconnect = asyncHandler(async (req, res) => {
  const { socialAccountId } = req.params;

  const account = await SocialAccount.findOne({
    _id: socialAccountId,
    userId: req.user._id,
    platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
  });

  if (!account) {
    throw new ApiError(404, "Social account not found.");
  }

  // Step 1: Try silent refresh with existing token
  const rawToken = account.userAccessToken || account.accessToken;
  if (rawToken) {
    let currentToken;
    try {
      currentToken = metaService.decryptToken(rawToken);
    } catch {
      // Token is corrupted — skip silent refresh
    }

    if (currentToken) {
      try {
        const refreshed = await metaService.exchangeForLongLivedToken(currentToken);

        const tokenExpiresAt = refreshed.expiresIn
          ? new Date(Date.now() + refreshed.expiresIn * 1000)
          : null;

        const encryptedNewToken = encrypt(refreshed.accessToken);

        // Re-fetch page token if Facebook account
        let newPageToken = account.accessToken;
        if (account.platform === SOCIAL_PLATFORMS.FACEBOOK && account.pageId) {
          try {
            const pages = await metaService.listManagedPages(refreshed.accessToken);
            const matched = pages.find((p) => p.pageId === account.accountId);
            if (matched) newPageToken = encrypt(matched.pageAccessToken);
          } catch {
            // Proceed with existing page token
          }
        }

        // Optimistic locking
        const currentVersion = account.tokenVersion || 0;
        const updateResult = await SocialAccount.findOneAndUpdate(
          { _id: account._id, tokenVersion: currentVersion },
          {
            $set: {
              userAccessToken: encryptedNewToken,
              accessToken: newPageToken,
              tokenExpiresAt,
              lastTokenRefreshedAt: new Date(),
              status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
              healthStatus: "healthy",
              disconnectReason: null,
              setupIssues: [],
            },
            $inc: { tokenVersion: 1 },
          }
        );

        if (updateResult) {
          // Sync linked IG account tokens
          if (account.platform === SOCIAL_PLATFORMS.FACEBOOK && account.pageId) {
            await SocialAccount.updateMany(
              {
                pageId: account.pageId,
                platform: SOCIAL_PLATFORMS.INSTAGRAM,
                userId: req.user._id,
              },
              {
                $set: {
                  userAccessToken: encryptedNewToken,
                  accessToken: newPageToken,
                  tokenExpiresAt,
                  lastTokenRefreshedAt: new Date(),
                  status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
                  healthStatus: "healthy",
                  disconnectReason: null,
                  setupIssues: [],
                },
                $inc: { tokenVersion: 1 },
              }
            );
          }

          // Invalidate cache and resume paused schedules
          metaService.invalidateStateCache(req.user._id);
          const { resumePausedSchedules } = require("../../jobs/postPublisher.job");
          resumePausedSchedules(account._id).catch(() => {});
          if (account.platform === SOCIAL_PLATFORMS.FACEBOOK && account.pageId) {
            SocialAccount.find({
              pageId: account.pageId,
              platform: SOCIAL_PLATFORMS.INSTAGRAM,
              userId: req.user._id,
            }).lean().then((igAccounts) => {
              for (const ig of igAccounts) {
                resumePausedSchedules(ig._id).catch(() => {});
              }
            }).catch(() => {});
          }

          return res.status(200).json(
            new ApiResponse(200, {
              reconnected: true,
              accountId: account._id.toString(),
              tokenExpiresAt,
            }, "Account reconnected successfully via silent refresh.")
          );
        }
        // If optimistic lock failed, token was refreshed by another process — still success
        metaService.invalidateStateCache(req.user._id);
        return res.status(200).json(
          new ApiResponse(200, {
            reconnected: true,
            accountId: account._id.toString(),
            note: "Token was already refreshed by another process.",
          }, "Account is already reconnected.")
        );
      } catch {
        // Silent refresh failed — fall through to OAuth
      }
    }
  }

  // Step 2: Silent refresh failed or no token — generate OAuth URL for re-auth
  const { url } = metaService.getAuthorizeUrl(req.user._id.toString(), {
    scopeType: "publish",
    isReconnect: true,
  });

  return res.status(200).json(
    new ApiResponse(200, {
      reconnected: false,
      oauthUrl: url,
      accountId: account._id.toString(),
    }, "Silent refresh failed. Please complete OAuth re-authorization.")
  );
});

/**
 * POST /social/meta/refresh-connection
 * Re-detect connection state after user completes an external action
 * (e.g., created a Facebook Page, linked Instagram, converted to Professional).
 * Uses the existing stored token — no new OAuth needed.
 */
const refreshConnection = asyncHandler(async (req, res) => {
  const detection = await metaService.detectConnectionState(req.user._id, {
    forceRefresh: true,
  });

  const message = CONNECTION_MESSAGES[detection.state] || CONNECTION_MESSAGES[CONNECTION_STATES.DETECTION_ERROR];

  const response = {
    state: detection.state,
    cached: false,
    title: message.title,
    description: message.description,
    actionLabel: message.actionLabel,
    actionType: message.actionType,
    pages: detection.pages || [],
    details: detection.details || {},
  };

  // Add OAuth URL for states that need it
  if (
    detection.state === CONNECTION_STATES.NO_FACEBOOK_LOGIN ||
    detection.state === CONNECTION_STATES.TOKEN_EXPIRED
  ) {
    const { url } = metaService.getAuthorizeUrl(req.user._id.toString(), {
      scopeType: "connect",
    });
    response.oauthUrl = url;
  }

  if (detection.state === CONNECTION_STATES.PERMISSIONS_MISSING) {
    const missingScopes = detection.details?.missingScopes || [];
    const { url } = metaService.getAuthorizeUrl(req.user._id.toString(), {
      scopeType: "missing",
      missingScopes,
    });
    response.oauthUrl = url;
    response.missingScopes = missingScopes;
  }

  if (message.actionUrl) {
    response.actionUrl = message.actionUrl;
  }
  if (message.secondaryAction) {
    response.secondaryAction = message.secondaryAction;
  }
  if (message.steps) {
    response.steps = message.steps;
  }

  // For PAGE_EXISTS_NO_IG, generate per-page action URLs
  if (detection.state === CONNECTION_STATES.PAGE_EXISTS_NO_IG && detection.pages?.length > 0) {
    const firstPage = detection.pages.find((p) => p.instagram?.linked === false);
    if (firstPage) {
      response.actionUrl = `https://www.facebook.com/${firstPage.pageId}/settings/?tab=instagram_management`;
    }
  }

  const refreshStates = [
    CONNECTION_STATES.NO_PAGE,
    CONNECTION_STATES.PAGE_EXISTS_NO_IG,
    CONNECTION_STATES.IG_PERSONAL,
    CONNECTION_STATES.RATE_LIMITED,
    CONNECTION_STATES.DETECTION_ERROR,
  ];
  response.showRefreshButton = refreshStates.includes(detection.state);

  return res.status(200).json(
    new ApiResponse(200, response, "Connection state refreshed.")
  );
});

module.exports = {
  getConnectionStatus,
  listPages,
  selectPages,
  getInstagramStatus,
  checkPermissions,
  refreshToken,
  reconnect,
  refreshConnection,
};
