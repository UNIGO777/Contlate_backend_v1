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
  const platform = account.platform?.toLowerCase();

  // ── Meta (Facebook / Instagram) ─────────────────────────────────────────
  if (platform === "facebook" || platform === "instagram") {
    const metaConfigured = Boolean(env.meta.appId && env.meta.appSecret);
    if (metaConfigured) {
      const metaService = require("./meta.service");
      const result = await metaService.publish({ account, content });
      return { ...result, platform };
    }
    if (env.nodeEnv !== "production") {
      return _devStub(account, content, platform);
    }
    throw Object.assign(new Error("Meta credentials are not configured."), { statusCode: 501 });
  }

  // ── LinkedIn ─────────────────────────────────────────────────────────────
  if (platform === "linkedin") {
    const linkedinConfigured = Boolean(env.linkedin.clientId && env.linkedin.clientSecret);
    if (linkedinConfigured) {
      const linkedinService = require("./linkedin.service");
      // authorUrn is stored in the refreshToken field during OAuth exchange
      const authorUrn = account.refreshToken || `urn:li:person:${account.accountId}`;
      const result = await linkedinService.publishImagePost({
        accessToken: account.accessToken,
        authorUrn,
        imageUrl: content.imageUrl,
        caption: content.caption,
      });
      return { ...result, platform };
    }
    if (env.nodeEnv !== "production") {
      return _devStub(account, content, platform);
    }
    throw Object.assign(new Error("LinkedIn credentials are not configured."), { statusCode: 501 });
  }

  // ── Unknown platform ─────────────────────────────────────────────────────
  if (env.nodeEnv !== "production") {
    return _devStub(account, content, platform);
  }
  throw Object.assign(new Error(`Unsupported platform: ${platform}`), { statusCode: 400 });
};

const _devStub = (account, content, platform) => {
  const fakeId = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  logger.info("[social] dev publish stub", {
    platform,
    accountId: account.accountId,
    contentId: content._id?.toString?.() || String(content._id),
    fakeId,
  });
  return { externalPostId: fakeId, platform };
};

module.exports = {
  normalizePlatform,
  isSupportedPlatform,
  normalizeSocialAccountPayload,
  publishToSocial,
};
