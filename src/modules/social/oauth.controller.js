const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const asyncHandler = require("../../core/asyncHandler");
const { SOCIAL_PLATFORMS } = require("../../constants/socialPlatforms");
const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");
const { encrypt } = require("../../core/tokenEncryption");
const metaService = require("../../services/meta.service");
const linkedinService = require("../../services/linkedin.service");
const Business = require("../business/business.model");
const SocialAccount = require("./social.model");

const startMetaOAuth = asyncHandler(async (req, res) => {
  const scopeType = req.query.scopeType || "connect";
  const { url } = metaService.getAuthorizeUrl(req.user.id, { scopeType });
  return res.status(200).json(new ApiResponse(200, { url, scopeType }, "Redirect the user to this URL."));
});

const completeMetaOAuth = asyncHandler(async (req, res) => {
  const { code, state, error: oauthError, error_description } = req.query;

  if (oauthError) {
    throw new ApiError(400, error_description || `Meta OAuth error: ${oauthError}`);
  }
  if (!code || !state) {
    throw new ApiError(400, "Missing OAuth code or state.");
  }

  const { userId, isReconnect } = metaService.verifyState(state);

  let short, long;
  try {
    short = await metaService.exchangeCodeForToken(code);
    long = await metaService.exchangeForLongLivedToken(short.accessToken);
  } catch (err) {
    if (err.isRateLimit) {
      throw new ApiError(429, "Facebook is temporarily busy. Please try again in a few minutes.");
    }
    throw err;
  }

  const business = await Business.findOne({ userId });
  if (!business) {
    throw new ApiError(400, "Connect a business profile before connecting social accounts.");
  }

  let pages;
  try {
    pages = await metaService.listManagedPages(long.accessToken);
  } catch (err) {
    if (err.isRateLimit) {
      throw new ApiError(429, "Facebook is temporarily busy. Please try again in a few minutes.");
    }
    throw err;
  }

  const tokenExpiresAt = long.expiresIn
    ? new Date(Date.now() + long.expiresIn * 1000)
    : null;

  const encryptedUserToken = encrypt(long.accessToken);

  // Detect granted scopes for storage
  let grantedScopes = [];
  try {
    const scopeResult = await metaService.detectMissingScopes(long.accessToken);
    grantedScopes = scopeResult.granted;
  } catch {
    // Non-fatal — scopes will be detected by health check later
  }

  // ── Reconnect flow: update existing accounts, mark missing pages ──
  if (isReconnect) {
    const existingAccounts = await SocialAccount.find({
      userId,
      platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
      status: { $ne: SOCIAL_ACCOUNT_STATUS.DISCONNECTED },
    }).lean();

    const newPageIds = new Set(pages.map((p) => p.pageId));
    const reconnected = [];

    // Update existing accounts with fresh tokens
    for (const page of pages) {
      const encryptedPageToken = encrypt(page.pageAccessToken);

      const fbResult = await SocialAccount.findOneAndUpdate(
        { userId, platform: SOCIAL_PLATFORMS.FACEBOOK, accountId: page.pageId },
        {
          $set: {
            accessToken: encryptedPageToken,
            userAccessToken: encryptedUserToken,
            tokenExpiresAt,
            lastTokenRefreshedAt: new Date(),
            status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
            healthStatus: "healthy",
            disconnectReason: null,
            grantedScopes,
            oauthScopeType: "full",
            setupIssues: [],
            lastSyncedAt: new Date(),
          },
          $inc: { tokenVersion: 1 },
          $setOnInsert: {
            userId,
            businessId: business._id,
            platform: SOCIAL_PLATFORMS.FACEBOOK,
            accountName: page.pageName,
            accountId: page.pageId,
            pageId: page.pageId,
          },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
      );
      reconnected.push(fbResult);

      if (page.instagramAccountId) {
        const igResult = await SocialAccount.findOneAndUpdate(
          { userId, platform: SOCIAL_PLATFORMS.INSTAGRAM, accountId: page.instagramAccountId },
          {
            $set: {
              accessToken: encryptedPageToken,
              userAccessToken: encryptedUserToken,
              pageId: page.pageId,
              tokenExpiresAt,
              lastTokenRefreshedAt: new Date(),
              status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
              healthStatus: "healthy",
              disconnectReason: null,
              grantedScopes,
              oauthScopeType: "full",
              setupIssues: [],
              lastSyncedAt: new Date(),
            },
            $inc: { tokenVersion: 1 },
            $setOnInsert: {
              userId,
              businessId: business._id,
              platform: SOCIAL_PLATFORMS.INSTAGRAM,
              accountName: page.instagramUsername || page.pageName,
              accountId: page.instagramAccountId,
            },
          },
          { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
        );
        reconnected.push(igResult);
      }
    }

    // Mark old pages that are no longer in the user's account as disconnected
    const fbAccountsToDisconnect = existingAccounts.filter(
      (a) => a.platform === SOCIAL_PLATFORMS.FACEBOOK && !newPageIds.has(a.accountId)
    );
    for (const old of fbAccountsToDisconnect) {
      await SocialAccount.findByIdAndUpdate(old._id, {
        $set: {
          status: SOCIAL_ACCOUNT_STATUS.DISCONNECTED,
          healthStatus: "critical",
          disconnectReason: "page_deleted",
        },
      });
    }

    // Invalidate cache and resume paused schedules
    metaService.invalidateStateCache(userId);
    const { resumePausedSchedules } = require("../../jobs/postPublisher.job");
    for (const acct of reconnected) {
      resumePausedSchedules(acct._id).catch(() => {});
    }

    // Subscribe pages to webhooks
    for (const page of pages) {
      metaService.subscribePageToWebhooks(page.pageId, page.pageAccessToken).catch(() => {});
    }

    return res.status(200).json(
      new ApiResponse(200, {
        reconnected: true,
        connected: reconnected.length,
        accounts: reconnected.map((a) => ({
          id: a._id.toString(),
          platform: a.platform,
          accountName: a.accountName,
          accountId: a.accountId,
        })),
        disconnected: fbAccountsToDisconnect.length,
      }, "Accounts reconnected successfully.")
    );
  }

  // Duplicate page detection: check for pages already connected by another user in this business
  if (pages.length > 0) {
    const pageAccountIds = pages.map((p) => p.pageId);
    const igAccountIds = pages.filter((p) => p.instagramAccountId).map((p) => p.instagramAccountId);
    const conflicting = await SocialAccount.find({
      businessId: business._id,
      userId: { $ne: userId },
      platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
      accountId: { $in: [...pageAccountIds, ...igAccountIds] },
      status: { $ne: SOCIAL_ACCOUNT_STATUS.DISCONNECTED },
    }).lean();

    // Filter out conflicting pages — skip them instead of failing the whole flow
    const conflictIds = new Set(conflicting.map((c) => c.accountId));
    const safePagesForUpsert = pages.filter(
      (p) => !conflictIds.has(p.pageId) && (!p.instagramAccountId || !conflictIds.has(p.instagramAccountId))
    );

    if (safePagesForUpsert.length === 0 && pages.length > 0) {
      throw new ApiError(409, "All your pages are already connected by another team member.");
    }

    // Use filtered pages for upsert
    pages.length = 0;
    pages.push(...safePagesForUpsert);
  }

  const upserts = [];
  for (const page of pages) {
    const encryptedPageToken = encrypt(page.pageAccessToken);

    upserts.push(
      SocialAccount.findOneAndUpdate(
        { userId, platform: SOCIAL_PLATFORMS.FACEBOOK, accountId: page.pageId },
        {
          $set: {
            userId,
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
            grantedScopes,
            oauthScopeType: "full",
            lastSyncedAt: new Date(),
            lastTokenRefreshedAt: new Date(),
          },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      )
    );

    if (page.instagramAccountId) {
      upserts.push(
        SocialAccount.findOneAndUpdate(
          {
            userId,
            platform: SOCIAL_PLATFORMS.INSTAGRAM,
            accountId: page.instagramAccountId,
          },
          {
            $set: {
              userId,
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
              grantedScopes,
              oauthScopeType: "full",
              lastSyncedAt: new Date(),
              lastTokenRefreshedAt: new Date(),
            },
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        )
      );
    }
  }

  const accounts = await Promise.all(upserts);

  // Invalidate connection state cache after OAuth
  metaService.invalidateStateCache(userId);

  // Subscribe each page to webhooks (fire-and-forget — non-fatal if it fails)
  for (const page of pages) {
    metaService.subscribePageToWebhooks(page.pageId, page.pageAccessToken).catch(() => {});
  }

  // Auto-resume paused schedules for reconnected accounts
  const { resumePausedSchedules } = require("../../jobs/postPublisher.job");
  for (const acct of accounts) {
    resumePausedSchedules(acct._id).catch(() => {});
  }

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        connected: accounts.length,
        accounts: accounts.map((a) => ({
          id: a._id.toString(),
          platform: a.platform,
          accountName: a.accountName,
          accountId: a.accountId,
        })),
      },
      "Meta accounts connected."
    )
  );
});

// ── POST /social/oauth/meta/exchange ────────────────────────────────────────
// Authenticated: system browser deep link returns code+state, frontend calls this.
// Instead of auto-connecting all pages, stores the user token and returns the pages
// list so the frontend can navigate to the page picker.
const exchangeMetaOAuth = asyncHandler(async (req, res) => {
  const { code, state } = req.body;

  if (!code || !state) throw new ApiError(400, "Missing code or state.");

  const { userId: stateUserId, isReconnect } = metaService.verifyState(state);
  if (stateUserId !== req.user.id) {
    throw new ApiError(400, "OAuth state does not match current user.");
  }

  const business = await Business.findOne({ userId: req.user.id });
  if (!business) {
    throw new ApiError(400, "Connect a business profile before connecting social accounts.");
  }

  let short, long, pages;
  try {
    short = await metaService.exchangeCodeForToken(code);
    long = await metaService.exchangeForLongLivedToken(short.accessToken);
    pages = await metaService.listManagedPages(long.accessToken);
  } catch (err) {
    if (err.isRateLimit) {
      throw new ApiError(429, "Facebook is temporarily busy. Please try again in a few minutes.");
    }
    throw err;
  }

  const tokenExpiresAt = long.expiresIn
    ? new Date(Date.now() + long.expiresIn * 1000)
    : null;

  const encryptedUserToken = encrypt(long.accessToken);

  // Detect granted scopes for storage
  let grantedScopes = [];
  try {
    const scopeResult = await metaService.detectMissingScopes(long.accessToken);
    grantedScopes = scopeResult.granted;
  } catch {
    // Non-fatal
  }

  const scopeType = req.body.scopeType || "connect";

  // Invalidate connection state cache
  metaService.invalidateStateCache(req.user.id);

  // ── Reconnect flow: update existing accounts, mark missing pages ──
  if (isReconnect) {
    const existingAccounts = await SocialAccount.find({
      userId: req.user.id,
      platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
      status: { $ne: SOCIAL_ACCOUNT_STATUS.DISCONNECTED },
    }).lean();

    const newPageIds = new Set(pages.map((p) => p.pageId));
    const reconnected = [];

    for (const page of pages) {
      const encryptedPageToken = encrypt(page.pageAccessToken);

      const fbResult = await SocialAccount.findOneAndUpdate(
        { userId: req.user.id, platform: SOCIAL_PLATFORMS.FACEBOOK, accountId: page.pageId },
        {
          $set: {
            accessToken: encryptedPageToken,
            userAccessToken: encryptedUserToken,
            tokenExpiresAt,
            lastTokenRefreshedAt: new Date(),
            status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
            healthStatus: "healthy",
            disconnectReason: null,
            grantedScopes,
            oauthScopeType: scopeType,
            setupIssues: [],
            lastSyncedAt: new Date(),
          },
          $inc: { tokenVersion: 1 },
          $setOnInsert: {
            userId: req.user.id,
            businessId: business._id,
            platform: SOCIAL_PLATFORMS.FACEBOOK,
            accountName: page.pageName,
            accountId: page.pageId,
            pageId: page.pageId,
          },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
      );
      reconnected.push(fbResult);

      if (page.instagramAccountId) {
        const igResult = await SocialAccount.findOneAndUpdate(
          { userId: req.user.id, platform: SOCIAL_PLATFORMS.INSTAGRAM, accountId: page.instagramAccountId },
          {
            $set: {
              accessToken: encryptedPageToken,
              userAccessToken: encryptedUserToken,
              pageId: page.pageId,
              tokenExpiresAt,
              lastTokenRefreshedAt: new Date(),
              status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
              healthStatus: "healthy",
              disconnectReason: null,
              grantedScopes,
              oauthScopeType: scopeType,
              setupIssues: [],
              lastSyncedAt: new Date(),
            },
            $inc: { tokenVersion: 1 },
            $setOnInsert: {
              userId: req.user.id,
              businessId: business._id,
              platform: SOCIAL_PLATFORMS.INSTAGRAM,
              accountName: page.instagramUsername || page.pageName,
              accountId: page.instagramAccountId,
            },
          },
          { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
        );
        reconnected.push(igResult);
      }
    }

    // Disconnect old pages no longer in user's account
    const fbToDisconnect = existingAccounts.filter(
      (a) => a.platform === SOCIAL_PLATFORMS.FACEBOOK && !newPageIds.has(a.accountId)
    );
    for (const old of fbToDisconnect) {
      await SocialAccount.findByIdAndUpdate(old._id, {
        $set: {
          status: SOCIAL_ACCOUNT_STATUS.DISCONNECTED,
          healthStatus: "critical",
          disconnectReason: "page_deleted",
        },
      });
    }

    // Resume paused schedules
    const { resumePausedSchedules } = require("../../jobs/postPublisher.job");
    for (const acct of reconnected) {
      resumePausedSchedules(acct._id).catch(() => {});
    }

    // Subscribe pages to webhooks
    for (const page of pages) {
      metaService.subscribePageToWebhooks(page.pageId, page.pageAccessToken).catch(() => {});
    }

    // Clean up pending_setup placeholders
    await SocialAccount.deleteMany({
      userId: req.user.id,
      status: SOCIAL_ACCOUNT_STATUS.PENDING_SETUP,
    });

    return res.status(200).json(
      new ApiResponse(200, {
        needsPagePicker: false,
        reconnected: true,
        connected: reconnected.length,
        accounts: reconnected.map((a) => ({
          id: a._id.toString(),
          platform: a.platform,
          accountName: a.accountName,
          accountId: a.accountId,
        })),
        pages: [],
        setupIssues: [],
        disconnected: fbToDisconnect.length,
      }, "Accounts reconnected successfully.")
    );
  }

  // If no pages, create a pending_setup placeholder to store the token
  if (pages.length === 0) {
    await SocialAccount.findOneAndUpdate(
      { userId: req.user.id, platform: SOCIAL_PLATFORMS.FACEBOOK, accountId: `pending_${req.user.id}` },
      {
        $set: {
          userId: req.user.id,
          businessId: business._id,
          platform: SOCIAL_PLATFORMS.FACEBOOK,
          accountName: "Pending Setup",
          accountId: `pending_${req.user.id}`,
          accessToken: encryptedUserToken,
          userAccessToken: encryptedUserToken,
          tokenExpiresAt,
          tokenVersion: 1,
          status: SOCIAL_ACCOUNT_STATUS.PENDING_SETUP,
          pendingExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          grantedScopes,
          oauthScopeType: scopeType,
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json(
      new ApiResponse(200, {
        needsPagePicker: false,
        connected: 0,
        accounts: [],
        pages: [],
        setupIssues: ["no_pages"],
      }, "No Facebook Pages found. Create a Page and come back.")
    );
  }

  // Duplicate page detection for auto-connect (single page)
  if (pages.length === 1) {
    const page = pages[0];
    const checkIds = [page.pageId];
    if (page.instagramAccountId) checkIds.push(page.instagramAccountId);

    const conflicting = await SocialAccount.find({
      businessId: business._id,
      userId: { $ne: req.user.id },
      platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
      accountId: { $in: checkIds },
      status: { $ne: SOCIAL_ACCOUNT_STATUS.DISCONNECTED },
    }).lean();

    if (conflicting.length > 0) {
      throw new ApiError(409, "This page is already connected by another team member.");
    }

    const encryptedPageToken = encrypt(page.pageAccessToken);
    const upserts = [];

    upserts.push(
      SocialAccount.findOneAndUpdate(
        { userId: req.user.id, platform: SOCIAL_PLATFORMS.FACEBOOK, accountId: page.pageId },
        {
          $set: {
            userId: req.user.id,
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
            grantedScopes,
            oauthScopeType: scopeType,
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
          { userId: req.user.id, platform: SOCIAL_PLATFORMS.INSTAGRAM, accountId: page.instagramAccountId },
          {
            $set: {
              userId: req.user.id,
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
              grantedScopes,
              oauthScopeType: scopeType,
              pendingExpiresAt: null,
              lastSyncedAt: new Date(),
              lastTokenRefreshedAt: new Date(),
            },
          },
          { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
        )
      );
    }

    const accounts = await Promise.all(upserts);

    // Clean up any pending_setup placeholder
    await SocialAccount.deleteMany({
      userId: req.user.id,
      status: SOCIAL_ACCOUNT_STATUS.PENDING_SETUP,
    });

    // Subscribe page to webhooks (fire-and-forget)
    metaService.subscribePageToWebhooks(page.pageId, page.pageAccessToken).catch(() => {});

    // Auto-resume paused schedules for reconnected accounts
    const { resumePausedSchedules } = require("../../jobs/postPublisher.job");
    for (const acct of accounts) {
      resumePausedSchedules(acct._id).catch(() => {});
    }

    return res.status(200).json(
      new ApiResponse(200, {
        needsPagePicker: false,
        connected: accounts.length,
        accounts: accounts.map((a) => ({
          id: a._id.toString(),
          platform: a.platform,
          accountName: a.accountName,
          accountId: a.accountId,
        })),
        pages: [],
        setupIssues: [],
      }, "Meta accounts connected.")
    );
  }

  // Multiple pages — store user token on a temporary placeholder account
  // so the select-pages endpoint can retrieve it, then return pages list.
  await SocialAccount.findOneAndUpdate(
    { userId: req.user.id, platform: SOCIAL_PLATFORMS.FACEBOOK, accountId: pages[0].pageId },
    {
      $set: {
        userId: req.user.id,
        businessId: business._id,
        platform: SOCIAL_PLATFORMS.FACEBOOK,
        accountName: pages[0].pageName,
        accountId: pages[0].pageId,
        accessToken: encrypt(pages[0].pageAccessToken),
        userAccessToken: encryptedUserToken,
        pageId: pages[0].pageId,
        tokenExpiresAt,
        tokenVersion: 1,
        status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
        healthStatus: "healthy",
        lastSyncedAt: new Date(),
        lastTokenRefreshedAt: new Date(),
      },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  // Multiple FB account detection hint:
  // If user previously had connected pages and none of the new pages match,
  // they may have logged in with a different Facebook account.
  let differentAccountHint = null;
  const newPageIds = new Set(pages.map((p) => p.pageId));
  const previousAccounts = await SocialAccount.find({
    userId: req.user.id,
    platform: SOCIAL_PLATFORMS.FACEBOOK,
    platformAccountId: { $nin: [...newPageIds] },
    status: { $in: [SOCIAL_ACCOUNT_STATUS.CONNECTED, SOCIAL_ACCOUNT_STATUS.EXPIRED] },
  }).lean();

  if (previousAccounts.length > 0) {
    differentAccountHint = "These pages don't match your previously connected account. You may have logged in with a different Facebook account.";
  }

  const responseData = {
    needsPagePicker: true,
    connected: 0,
    accounts: [],
    pages: pages.map((p) => ({
      pageId: p.pageId,
      pageName: p.pageName,
      instagramAccountId: p.instagramAccountId || null,
      instagramUsername: p.instagramUsername || null,
      hasInstagram: !!p.instagramAccountId,
      canPublish: p.canPublish,
    })),
    setupIssues: [],
  };

  if (differentAccountHint) {
    responseData.differentAccountHint = differentAccountHint;
  }

  return res.status(200).json(
    new ApiResponse(200, responseData, "Multiple pages found. Select which pages to connect.")
  );
});

// ── GET /social/oauth/linkedin/start ────────────────────────────────────────
const startLinkedInOAuth = asyncHandler(async (req, res) => {
  const { url } = linkedinService.getAuthorizeUrl(req.user.id);
  return res.status(200).json(new ApiResponse(200, { url }, "Redirect to this URL."));
});

// ── POST /social/oauth/linkedin/exchange ─────────────────────────────────────
// Authenticated: frontend WebView intercepts the callback, calls this with code+state.
const exchangeLinkedInOAuth = asyncHandler(async (req, res) => {
  const { code, state } = req.body;

  if (!code || !state) throw new ApiError(400, "Missing code or state.");

  linkedinService.verifyState(state);

  const business = await Business.findOne({ userId: req.user.id });
  if (!business) {
    throw new ApiError(400, "Connect a business profile before connecting social accounts.");
  }

  const { accessToken, expiresIn } = await linkedinService.exchangeCodeForToken(code);
  const profile = await linkedinService.getProfile(accessToken);

  const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

  // LinkedIn URN (used when publishing posts)
  const authorUrn = `urn:li:person:${profile.sub}`;

  const account = await SocialAccount.findOneAndUpdate(
    { userId: req.user.id, platform: SOCIAL_PLATFORMS.LINKEDIN, accountId: profile.sub },
    {
      $set: {
        userId: req.user.id,
        businessId: business._id,
        platform: SOCIAL_PLATFORMS.LINKEDIN,
        accountName: profile.name,
        accountId: profile.sub,
        accessToken: encrypt(accessToken),
        refreshToken: authorUrn, // store authorUrn in refreshToken field for publishing
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
  );

  return res.status(200).json(
    new ApiResponse(200, {
      connected: 1,
      accounts: [{
        id: account._id.toString(),
        platform: account.platform,
        accountName: account.accountName,
        accountId: account.accountId,
      }],
    }, "LinkedIn account connected.")
  );
});

module.exports = {
  startMetaOAuth,
  completeMetaOAuth,
  exchangeMetaOAuth,
  startLinkedInOAuth,
  exchangeLinkedInOAuth,
};
