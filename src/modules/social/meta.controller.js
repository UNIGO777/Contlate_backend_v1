const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const asyncHandler = require("../../core/asyncHandler");
const { SOCIAL_PLATFORMS } = require("../../constants/socialPlatforms");
const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");
const { encrypt, decrypt } = require("../../core/tokenEncryption");
const metaService = require("../../services/meta.service");
const SocialAccount = require("./social.model");

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

  // Subscribe selected pages to webhooks (fire-and-forget)
  for (const page of selectedPages) {
    metaService.subscribePageToWebhooks(page.pageId, page.pageAccessToken).catch(() => {});
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
 */
const checkPermissions = asyncHandler(async (req, res) => {
  const account = await SocialAccount.findOne({
    userId: req.user._id,
    platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
    status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
    userAccessToken: { $ne: "" },
  });

  if (!account) {
    throw new ApiError(400, "No connected Meta account found.");
  }

  const userToken = metaService.decryptToken(account.userAccessToken);

  const data = await metaService.graphFetch("/me/permissions", {
    searchParams: { access_token: userToken },
  });

  const permissions = (data.data || []).map((p) => ({
    permission: p.permission,
    status: p.status, // "granted" or "declined"
  }));

  const required = metaService.SCOPES;
  const missing = required.filter(
    (scope) => !permissions.find((p) => p.permission === scope && p.status === "granted")
  );

  return res.status(200).json(
    new ApiResponse(200, {
      permissions,
      required,
      missing,
      allGranted: missing.length === 0,
    }, "Permissions checked.")
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

  await SocialAccount.findByIdAndUpdate(account._id, {
    $set: {
      userAccessToken: encryptedNewToken,
      accessToken: newPageToken,
      tokenExpiresAt,
      lastTokenRefreshedAt: new Date(),
      status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
      healthStatus: "healthy",
      disconnectReason: null,
    },
  });

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
      }
    );
  }

  return res.status(200).json(
    new ApiResponse(200, {
      accountId: account._id.toString(),
      tokenExpiresAt,
      refreshedAt: new Date(),
    }, "Token refreshed successfully.")
  );
});

module.exports = {
  listPages,
  selectPages,
  getInstagramStatus,
  checkPermissions,
  refreshToken,
};
