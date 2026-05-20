const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const asyncHandler = require("../../core/asyncHandler");
const { SOCIAL_PLATFORMS } = require("../../constants/socialPlatforms");
const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");
const metaService = require("../../services/meta.service");
const linkedinService = require("../../services/linkedin.service");
const Business = require("../business/business.model");
const SocialAccount = require("./social.model");

const startMetaOAuth = asyncHandler(async (req, res) => {
  const { url } = metaService.getAuthorizeUrl(req.user.id);
  return res.status(200).json(new ApiResponse(200, { url }, "Redirect the user to this URL."));
});

const completeMetaOAuth = asyncHandler(async (req, res) => {
  const { code, state, error: oauthError, error_description } = req.query;

  if (oauthError) {
    throw new ApiError(400, error_description || `Meta OAuth error: ${oauthError}`);
  }
  if (!code || !state) {
    throw new ApiError(400, "Missing OAuth code or state.");
  }

  const { userId } = metaService.verifyState(state);

  const short = await metaService.exchangeCodeForToken(code);
  const long = await metaService.exchangeForLongLivedToken(short.accessToken);

  const business = await Business.findOne({ userId });
  if (!business) {
    throw new ApiError(400, "Connect a business profile before connecting social accounts.");
  }

  const pages = await metaService.listManagedPages(long.accessToken);

  const tokenExpiresAt = long.expiresIn
    ? new Date(Date.now() + long.expiresIn * 1000)
    : null;

  const upserts = [];
  for (const page of pages) {
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
            accessToken: page.pageAccessToken,
            tokenExpiresAt,
            status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
            lastSyncedAt: new Date(),
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
              accessToken: page.pageAccessToken,
              tokenExpiresAt,
              status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
              lastSyncedAt: new Date(),
            },
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        )
      );
    }
  }

  const accounts = await Promise.all(upserts);

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
// Authenticated: frontend WebView intercepts the callback URL, extracts code+state,
// then calls this endpoint directly with the user's auth token.
const exchangeMetaOAuth = asyncHandler(async (req, res) => {
  const { code, state } = req.body;

  if (!code || !state) throw new ApiError(400, "Missing code or state.");

  const { userId } = metaService.verifyState(state);

  const business = await Business.findOne({ userId: req.user._id });
  if (!business) {
    throw new ApiError(400, "Connect a business profile before connecting social accounts.");
  }

  const short = await metaService.exchangeCodeForToken(code);
  const long = await metaService.exchangeForLongLivedToken(short.accessToken);
  const pages = await metaService.listManagedPages(long.accessToken);

  const tokenExpiresAt = long.expiresIn
    ? new Date(Date.now() + long.expiresIn * 1000)
    : null;

  const upserts = [];
  for (const page of pages) {
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
            accessToken: page.pageAccessToken,
            tokenExpiresAt,
            status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
            lastSyncedAt: new Date(),
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
              accessToken: page.pageAccessToken,
              tokenExpiresAt,
              status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
              lastSyncedAt: new Date(),
            },
          },
          { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
        )
      );
    }
  }

  const accounts = await Promise.all(upserts);

  return res.status(200).json(
    new ApiResponse(200, {
      connected: accounts.length,
      accounts: accounts.map((a) => ({
        id: a._id.toString(),
        platform: a.platform,
        accountName: a.accountName,
        accountId: a.accountId,
      })),
    }, "Meta accounts connected.")
  );
});

// ── GET /social/oauth/linkedin/start ────────────────────────────────────────
const startLinkedInOAuth = asyncHandler(async (req, res) => {
  const { url } = linkedinService.getAuthorizeUrl(req.user._id);
  return res.status(200).json(new ApiResponse(200, { url }, "Redirect to this URL."));
});

// ── POST /social/oauth/linkedin/exchange ─────────────────────────────────────
// Authenticated: frontend WebView intercepts the callback, calls this with code+state.
const exchangeLinkedInOAuth = asyncHandler(async (req, res) => {
  const { code, state } = req.body;

  if (!code || !state) throw new ApiError(400, "Missing code or state.");

  linkedinService.verifyState(state);

  const business = await Business.findOne({ userId: req.user._id });
  if (!business) {
    throw new ApiError(400, "Connect a business profile before connecting social accounts.");
  }

  const { accessToken, expiresIn } = await linkedinService.exchangeCodeForToken(code);
  const profile = await linkedinService.getProfile(accessToken);

  const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

  // LinkedIn URN (used when publishing posts)
  const authorUrn = `urn:li:person:${profile.sub}`;

  const account = await SocialAccount.findOneAndUpdate(
    { userId: req.user._id, platform: SOCIAL_PLATFORMS.LINKEDIN, accountId: profile.sub },
    {
      $set: {
        userId: req.user._id,
        businessId: business._id,
        platform: SOCIAL_PLATFORMS.LINKEDIN,
        accountName: profile.name,
        accountId: profile.sub,
        accessToken,
        refreshToken: authorUrn, // store authorUrn in refreshToken field for publishing
        tokenExpiresAt,
        status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
        lastSyncedAt: new Date(),
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
