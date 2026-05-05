const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const asyncHandler = require("../../core/asyncHandler");
const { SOCIAL_PLATFORMS } = require("../../constants/socialPlatforms");
const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");
const metaService = require("../../services/meta.service");
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
        { upsert: true, new: true, setDefaultsOnInsert: true }
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
          { upsert: true, new: true, setDefaultsOnInsert: true }
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

module.exports = { startMetaOAuth, completeMetaOAuth };
