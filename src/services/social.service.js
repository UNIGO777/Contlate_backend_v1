const env = require("../config/env");
const logger = require("../core/logger");
const { SOCIAL_PLATFORMS } = require("../constants/socialPlatforms");
const { SOCIAL_ACCOUNT_STATUS } = require("../constants/socialAccountStatus");

const normalizePlatform = (platform) => {
  return String(platform || "")
    .trim()
    .toLowerCase();
};

const isSupportedPlatform = (platform) => {
  return Object.values(SOCIAL_PLATFORMS).includes(normalizePlatform(platform));
};

const normalizeSocialAccountPayload = (payload = {}) => {
  return {
    platform: normalizePlatform(payload.platform),
    accountName: String(payload.accountName || "").trim(),
    accountId: String(payload.accountId || "").trim(),
    accessToken: String(payload.accessToken || "").trim(),
    refreshToken: String(payload.refreshToken || "").trim(),
    tokenExpiresAt: payload.tokenExpiresAt ? new Date(payload.tokenExpiresAt) : null,
    status: payload.status || SOCIAL_ACCOUNT_STATUS.CONNECTED,
  };
};

// Publishes a piece of content to the given social account.
// Uses the real Meta Graph API when META_APP_ID/SECRET are configured.
// In dev without Meta credentials, returns a synthetic post id so the pipeline
// can be exercised end-to-end.
const publishToSocial = async ({ account, content }) => {
  const metaConfigured = Boolean(env.meta.appId && env.meta.appSecret);

  if (metaConfigured) {
    const metaService = require("./meta.service");
    const result = await metaService.publish({ account, content });
    return { ...result, platform: account.platform };
  }

  if (env.nodeEnv !== "production") {
    const fakeId = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    logger.info("[social] dev publish stub", {
      platform: account.platform,
      accountId: account.accountId,
      contentId: content._id?.toString?.() || String(content._id),
      fakeId,
    });
    return { externalPostId: fakeId, platform: account.platform };
  }

  const error = new Error("Meta credentials are not configured on this server.");
  error.statusCode = 501;
  throw error;
};

module.exports = {
  normalizePlatform,
  isSupportedPlatform,
  normalizeSocialAccountPayload,
  publishToSocial,
};
