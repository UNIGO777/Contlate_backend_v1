const crypto = require("crypto");
const env = require("../config/env");
const ApiError = require("../core/ApiError");
const logger = require("../core/logger");
const { decrypt } = require("../core/tokenEncryption");

const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "business_management",
];

const ensureConfigured = () => {
  if (!env.meta.appId || !env.meta.appSecret) {
    throw new ApiError(501, "Meta OAuth is not configured on this server.");
  }
};

const buildState = (userId) => {
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = `${userId}.${Date.now()}.${nonce}`;
  const sig = crypto
    .createHmac("sha256", env.meta.oauthStateSecret)
    .update(payload)
    .digest("hex");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
};

const verifyState = (state) => {
  let decoded;
  try {
    decoded = Buffer.from(String(state || ""), "base64url").toString("utf8");
  } catch {
    throw new ApiError(400, "Invalid OAuth state.");
  }
  const parts = decoded.split(".");
  if (parts.length !== 4) throw new ApiError(400, "Invalid OAuth state.");
  const [userId, ts, nonce, sig] = parts;
  const expected = crypto
    .createHmac("sha256", env.meta.oauthStateSecret)
    .update(`${userId}.${ts}.${nonce}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(400, "Invalid OAuth state signature.");
  }
  if (Date.now() - Number(ts) > 15 * 60 * 1000) {
    throw new ApiError(400, "OAuth state expired.");
  }
  return { userId };
};

const getAuthorizeUrl = (userId) => {
  ensureConfigured();
  const state = buildState(userId);
  const url = new URL(
    `https://www.facebook.com/${env.meta.graphVersion}/dialog/oauth`
  );
  url.searchParams.set("client_id", env.meta.appId);
  url.searchParams.set("redirect_uri", env.meta.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  return { url: url.toString(), state };
};

// ── Meta Graph API error codes ────────────────────────────────────────────────
// https://developers.facebook.com/docs/graph-api/guides/error-handling
const META_ERROR_MESSAGES = {
  190: "Access token expired or revoked. Please reconnect your account.",
  200: "Missing required permission. Please reconnect and grant all permissions.",
  100: "Invalid parameter sent to Meta Graph API.",
  10:  "App does not have permission for this action.",
  4:   "Meta API rate limit reached. Please try again later.",
  17:  "Meta API rate limit reached. Please try again later.",
  341: "Meta API feed action rate limit reached. Please try again later.",
};

const classifyMetaError = (json, status) => {
  const code = json?.error?.code;
  const subcode = json?.error?.error_subcode;
  const friendly = META_ERROR_MESSAGES[code] || META_ERROR_MESSAGES[subcode];
  const isRateLimit = code === 4 || code === 17 || code === 341 || status === 429;
  const isAuthError = code === 190;
  return { code, subcode, friendly, isRateLimit, isAuthError };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch from Meta Graph API with rate-limit retry.
 * Respects the Retry-After header on 429 responses.
 * Retries up to 2 times on rate-limit errors, then throws.
 */
const graphFetch = async (path, { method = "GET", searchParams, body } = {}, _attempt = 0) => {
  const url = new URL(`https://graph.facebook.com/${env.meta.graphVersion}${path}`);
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const { code, friendly, isRateLimit, isAuthError } = classifyMetaError(json, res.status);

    // Retry rate-limit errors up to 2 times
    if (isRateLimit && _attempt < 2) {
      const retryAfterHeader = res.headers.get("retry-after") || res.headers.get("x-app-usage");
      // Default backoff: 60s for first retry, 120s for second
      const waitMs = retryAfterHeader
        ? Math.min(parseInt(retryAfterHeader, 10) * 1000, 5 * 60 * 1000)
        : ((_attempt + 1) * 60 * 1000);

      logger.warn("[meta] rate limit hit, retrying", {
        path,
        attempt: _attempt + 1,
        waitMs,
        code,
      });

      await sleep(waitMs);
      return graphFetch(path, { method, searchParams, body }, _attempt + 1);
    }

    const message = friendly || json?.error?.message || `Graph API error (${res.status}).`;
    const err = new Error(message);
    err.statusCode = res.status;
    err.metaCode = code;
    err.isAuthError = isAuthError;
    err.isRateLimit = isRateLimit;
    err.details = json;
    throw err;
  }

  return json;
};

const exchangeCodeForToken = async (code) => {
  ensureConfigured();
  const data = await graphFetch("/oauth/access_token", {
    searchParams: {
      client_id: env.meta.appId,
      client_secret: env.meta.appSecret,
      redirect_uri: env.meta.redirectUri,
      code,
    },
  });
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in || null,
  };
};

const exchangeForLongLivedToken = async (shortLivedToken) => {
  const data = await graphFetch("/oauth/access_token", {
    searchParams: {
      grant_type: "fb_exchange_token",
      client_id: env.meta.appId,
      client_secret: env.meta.appSecret,
      fb_exchange_token: shortLivedToken,
    },
  });
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in || null,
  };
};

const listManagedPages = async (userAccessToken) => {
  const data = await graphFetch("/me/accounts", {
    searchParams: {
      access_token: userAccessToken,
      fields: "id,name,access_token,instagram_business_account{id,username}",
      limit: 100,
    },
  });
  return (data.data || []).map((p) => ({
    pageId: p.id,
    pageName: p.name,
    pageAccessToken: p.access_token,
    instagramAccountId: p.instagram_business_account?.id || null,
    instagramUsername: p.instagram_business_account?.username || null,
  }));
};

const publishToFacebookPage = async ({ pageId, pageAccessToken, imageUrl, caption }) => {
  const data = await graphFetch(`/${pageId}/photos`, {
    method: "POST",
    searchParams: {
      url: imageUrl,
      caption: caption || "",
      access_token: pageAccessToken,
    },
  });
  return { externalPostId: data.post_id || data.id };
};

const publishToInstagram = async ({
  instagramAccountId,
  pageAccessToken,
  imageUrl,
  caption,
}) => {
  const container = await graphFetch(`/${instagramAccountId}/media`, {
    method: "POST",
    searchParams: {
      image_url: imageUrl,
      caption: caption || "",
      access_token: pageAccessToken,
    },
  });
  if (!container.id) {
    throw new Error("Failed to create Instagram media container.");
  }
  const published = await graphFetch(`/${instagramAccountId}/media_publish`, {
    method: "POST",
    searchParams: {
      creation_id: container.id,
      access_token: pageAccessToken,
    },
  });
  return { externalPostId: published.id };
};

/**
 * Decrypt a token if it's in encrypted format (version:iv:authTag:ciphertext),
 * otherwise return as-is for backward compatibility with plaintext tokens.
 */
const decryptToken = (token) => {
  if (!token) return token;
  // Encrypted tokens have exactly 3 colons (4 parts): version:iv:authTag:ciphertext
  if (token.split(":").length === 4) {
    return decrypt(token);
  }
  return token;
};

const publish = async ({ account, content }) => {
  if (!account.accessToken) {
    throw new Error("Social account has no access token. Reconnect required.");
  }

  if (!account.pageId && !account.accountId) {
    throw new Error("Publishing requires a Page ID. Personal profiles not supported.");
  }

  const pageAccessToken = decryptToken(account.accessToken);

  if (account.platform === "facebook") {
    return publishToFacebookPage({
      pageId: account.accountId,
      pageAccessToken,
      imageUrl: content.imageUrl,
      caption: content.caption,
    });
  }
  if (account.platform === "instagram") {
    return publishToInstagram({
      instagramAccountId: account.accountId,
      pageAccessToken,
      imageUrl: content.imageUrl,
      caption: content.caption,
    });
  }
  throw new Error(`Unsupported platform: ${account.platform}`);
};

/**
 * Subscribe a Facebook Page to receive webhook events.
 * Must be called after connecting a Page so Meta will push events to our webhook URL.
 * See: https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages
 *
 * @param {string} pageId
 * @param {string} pageAccessToken  — decrypted page-level token
 */
const subscribePageToWebhooks = async (pageId, pageAccessToken) => {
  try {
    await graphFetch(`/${pageId}/subscribed_apps`, {
      method: "POST",
      searchParams: {
        subscribed_fields: "feed,name,picture",
        access_token: pageAccessToken,
      },
    });
    logger.info("[meta.service] page subscribed to webhooks", { pageId });
  } catch (err) {
    // Non-fatal — webhooks are a best-effort feature
    logger.warn("[meta.service] page webhook subscription failed", {
      pageId,
      message: err.message,
    });
  }
};

module.exports = {
  ensureConfigured,
  getAuthorizeUrl,
  verifyState,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  listManagedPages,
  publish,
  decryptToken,
  graphFetch,
  subscribePageToWebhooks,
  SCOPES,
};
