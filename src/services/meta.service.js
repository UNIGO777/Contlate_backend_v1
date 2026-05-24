const crypto = require("crypto");
const env = require("../config/env");
const ApiError = require("../core/ApiError");
const logger = require("../core/logger");
const { decrypt } = require("../core/tokenEncryption");
const { CONNECTION_STATES } = require("../constants/connectionStates");
const { SOCIAL_PLATFORMS } = require("../constants/socialPlatforms");
const { SOCIAL_ACCOUNT_STATUS } = require("../constants/socialAccountStatus");

const CONNECT_SCOPES = [
  "public_profile",
  // "email",
  "pages_show_list",
  // "pages_read_engagement",
];

const PUBLISH_SCOPES = [
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "business_management",
];

const ALL_SCOPES = [...CONNECT_SCOPES, ...PUBLISH_SCOPES];

// Backward-compat alias — existing code references metaService.SCOPES
const SCOPES = ALL_SCOPES;

const ensureConfigured = () => {
  if (!env.meta.appId || !env.meta.appSecret) {
    throw new ApiError(501, "Meta OAuth is not configured on this server.");
  }
};

// ── OAuth nonce one-time-use tracking ────────────────────────────────────────
// Prevents replay of OAuth callback URLs within the 15-minute state window.
const usedNonces = new Map();
const NONCE_TTL_MS = 15 * 60 * 1000; // matches state expiry

// Cleanup expired nonces every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - NONCE_TTL_MS;
  for (const [nonce, ts] of usedNonces) {
    if (ts < cutoff) usedNonces.delete(nonce);
  }
}, 5 * 60 * 1000).unref();

const buildState = (userId, { isReconnect = false } = {}) => {
  const nonce = crypto.randomBytes(16).toString("hex");
  const flags = isReconnect ? "reconnect" : "";
  const payload = `${userId}.${Date.now()}.${nonce}.${flags}`;
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
  // Support both old (4-part) and new (5-part with flags) format
  if (parts.length !== 4 && parts.length !== 5) throw new ApiError(400, "Invalid OAuth state.");

  let userId, ts, nonce, flags, sig;
  if (parts.length === 5) {
    [userId, ts, nonce, flags, sig] = parts;
  } else {
    [userId, ts, nonce, sig] = parts;
    flags = "";
  }

  const payload = parts.length === 5
    ? `${userId}.${ts}.${nonce}.${flags}`
    : `${userId}.${ts}.${nonce}`;
  const expected = crypto
    .createHmac("sha256", env.meta.oauthStateSecret)
    .update(payload)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(400, "Invalid OAuth state signature.");
  }
  if (Date.now() - Number(ts) > 15 * 60 * 1000) {
    throw new ApiError(400, "OAuth state expired.");
  }

  // One-time-use: reject if nonce was already consumed
  if (usedNonces.has(nonce)) {
    throw new ApiError(400, "OAuth state already consumed.");
  }
  usedNonces.set(nonce, Date.now());

  const isReconnect = (flags || "").includes("reconnect");
  return { userId, isReconnect };
};

/**
 * Generate a Meta OAuth authorization URL.
 *
 * @param {string} userId
 * @param {object} [opts]
 * @param {"connect"|"publish"|"missing"} [opts.scopeType="connect"]
 * @param {string[]} [opts.missingScopes]  — used when scopeType="missing"
 */
const getAuthorizeUrl = (userId, { scopeType = "connect", missingScopes = [], isReconnect = false } = {}) => {
  ensureConfigured();
  const state = buildState(userId, { isReconnect });
  const url = new URL(
    `https://www.facebook.com/dialog/oauth`
  );
  url.searchParams.set("client_id", env.meta.appId);
  url.searchParams.set("redirect_uri", env.meta.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");

  let scopes;
  if (scopeType === "connect") {
    scopes = CONNECT_SCOPES;
  } else if (scopeType === "missing" && missingScopes.length > 0) {
    scopes = missingScopes;
    url.searchParams.set("auth_type", "rerequest");
  } else {
    // "publish" or default — request all scopes
    scopes = ALL_SCOPES;
    if (scopeType === "publish") {
      url.searchParams.set("auth_type", "rerequest");
    }
  }

  url.searchParams.set("scope", scopes.join(","));
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

  // Failure classification for publish pipeline
  let failureType = "retryable"; // default
  if (isRateLimit || status === 500 || status === 502 || status === 503) {
    failureType = "retryable";
  } else if (isAuthError || code === 200 || code === 10) {
    // Token expired, permission missing, app not authorized
    failureType = "recoverable";
  } else if (code === 368 || code === 2207051) {
    // Content policy violation, spam detection
    failureType = "permanent";
  } else if (code === 100 && json?.error?.error_subcode === 33) {
    // Invalid media — permanent
    failureType = "permanent";
  }

  return { code, subcode, friendly, isRateLimit, isAuthError, failureType };
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
    const { code, friendly, isRateLimit, isAuthError, failureType } = classifyMetaError(json, res.status);

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
    err.failureType = failureType;
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
      fields: "id,name,access_token,instagram_business_account{id,username},tasks",
      limit: 100,
    },
  });
  return (data.data || []).map((p) => {
    const tasks = p.tasks || [];
    const canPublish = tasks.includes("CREATE_CONTENT") || tasks.includes("MANAGE");
    return {
      pageId: p.id,
      pageName: p.name,
      pageAccessToken: p.access_token,
      instagramAccountId: p.instagram_business_account?.id || null,
      instagramUsername: p.instagram_business_account?.username || null,
      tasks,
      canPublish,
    };
  });
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
 * Fast pre-publish permission check using cached grantedScopes from DB.
 * Does NOT make a live API call — uses the scopes stored during OAuth or health check.
 * If cached scopes are empty, assumes OK (will fail at publish time and get caught).
 *
 * @param {object} account — SocialAccount document (or lean object)
 * @returns {{ allowed: boolean, reason?: string }}
 */
const canAccountPublish = (account) => {
  const scopes = account.grantedScopes || [];

  // No cached scopes — can't determine, allow and let publish fail if needed
  if (scopes.length === 0) return { allowed: true };

  if (account.platform === "facebook") {
    if (!scopes.includes("pages_manage_posts")) {
      return { allowed: false, reason: "Missing permission: pages_manage_posts" };
    }
    return { allowed: true };
  }

  if (account.platform === "instagram") {
    const missing = [];
    if (!scopes.includes("instagram_basic")) missing.push("instagram_basic");
    if (!scopes.includes("instagram_content_publish")) missing.push("instagram_content_publish");
    if (missing.length > 0) {
      return { allowed: false, reason: `Missing permissions: ${missing.join(", ")}` };
    }
    return { allowed: true };
  }

  return { allowed: true };
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

// ── Connection State Detection ───────────────────────────────────────────────

// Lazy-load SocialAccount to avoid circular dependency
let _SocialAccount;
const getSocialAccountModel = () => {
  if (!_SocialAccount) {
    _SocialAccount = require("../modules/social/social.model");
  }
  return _SocialAccount;
};

// In-memory state cache — 5 minute TTL
const stateCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Invalidate the cached connection state for a user.
 * Call after any event that changes connection state (OAuth, reconnect, webhook, refresh).
 */
const invalidateStateCache = (userId) => {
  stateCache.delete(String(userId));
};

// Periodic cleanup of expired cache entries (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stateCache) {
    if (now - entry.timestamp > CACHE_TTL_MS) stateCache.delete(key);
  }
}, 10 * 60 * 1000).unref();

/**
 * Get detailed status for a single page: IG linkage, IG account type, etc.
 *
 * @param {object} page — page object from listManagedPages
 * @param {string} userAccessToken — decrypted user-level token
 * @returns {object} page detail with instagram status
 */
const getPageDetailedStatus = async (page, userAccessToken) => {
  const detail = {
    pageId: page.pageId,
    pageName: page.pageName,
    canPublishFacebook: true,
    instagram: null,
  };

  if (!page.instagramAccountId) {
    detail.instagram = { linked: false, status: "NOT_CONNECTED" };
    return detail;
  }

  // IG is linked — check account type
  try {
    const igData = await graphFetch(`/${page.instagramAccountId}`, {
      searchParams: {
        fields: "id,username,account_type",
        access_token: userAccessToken,
      },
    });

    const accountType = igData.account_type || null;
    const isProfessional =
      accountType === "BUSINESS" || accountType === "MEDIA_CREATOR";

    detail.instagram = {
      linked: true,
      accountId: page.instagramAccountId,
      username: igData.username || page.instagramUsername || null,
      accountType,
      isProfessional,
      status: isProfessional ? "READY" : "NEEDS_CONVERSION",
    };
  } catch {
    // Could not fetch IG details — treat as linked but status unknown
    detail.instagram = {
      linked: true,
      accountId: page.instagramAccountId,
      username: page.instagramUsername || null,
      accountType: null,
      isProfessional: false,
      status: "UNKNOWN",
    };
  }

  return detail;
};

/**
 * Detect which scopes are granted, declined, or missing.
 *
 * @param {string} userAccessToken — decrypted user-level token
 * @returns {{ granted: string[], declined: string[], missing: string[] }}
 */
const detectMissingScopes = async (userAccessToken) => {
  const data = await graphFetch("/me/permissions", {
    searchParams: { access_token: userAccessToken },
  });

  const permMap = {};
  for (const p of data.data || []) {
    permMap[p.permission] = p.status;
  }

  const granted = [];
  const declined = [];
  const missing = [];

  for (const scope of ALL_SCOPES) {
    if (permMap[scope] === "granted") {
      granted.push(scope);
    } else if (permMap[scope] === "declined") {
      declined.push(scope);
    } else {
      missing.push(scope);
    }
  }

  return { granted, declined, missing };
};

/**
 * Detect the current Meta connection state for a user.
 * The state is computed live (never stored) and cached for 5 minutes.
 *
 * @param {string} userId
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh=false] — bypass cache
 * @returns {object} { state, action, details, pages, cached }
 */
const detectConnectionState = async (userId, { forceRefresh = false } = {}) => {
  const cacheKey = String(userId);

  // Check cache first
  if (!forceRefresh) {
    const cached = stateCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return { ...cached.result, cached: true };
    }
  }

  const SocialAccount = getSocialAccountModel();
  let result;

  try {
    // Step 1: Check if any Meta accounts exist in DB
    const accounts = await SocialAccount.find({
      userId,
      platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
      status: { $nin: [SOCIAL_ACCOUNT_STATUS.DISCONNECTED] },
    }).lean();

    if (accounts.length === 0) {
      result = {
        state: CONNECTION_STATES.NO_FACEBOOK_LOGIN,
        details: { hasToken: false, pages: [], missingScopes: [] },
        pages: [],
      };
      stateCache.set(cacheKey, { result, timestamp: Date.now() });
      return { ...result, cached: false };
    }

    // Step 2: Get the userAccessToken
    const tokenAccount = accounts.find((a) => a.userAccessToken);
    if (!tokenAccount || !tokenAccount.userAccessToken) {
      result = {
        state: CONNECTION_STATES.TOKEN_EXPIRED,
        details: { hasToken: false, pages: [], missingScopes: [] },
        pages: [],
      };
      stateCache.set(cacheKey, { result, timestamp: Date.now() });
      return { ...result, cached: false };
    }

    let userAccessToken;
    try {
      userAccessToken = decryptToken(tokenAccount.userAccessToken);
    } catch {
      result = {
        state: CONNECTION_STATES.TOKEN_EXPIRED,
        details: { hasToken: false, pages: [], missingScopes: [] },
        pages: [],
      };
      stateCache.set(cacheKey, { result, timestamp: Date.now() });
      return { ...result, cached: false };
    }

    // Step 3: Verify token is valid
    try {
      await graphFetch("/me", {
        searchParams: { access_token: userAccessToken },
      });
    } catch (err) {
      if (err.isAuthError || err.metaCode === 190) {
        result = {
          state: CONNECTION_STATES.TOKEN_EXPIRED,
          details: { hasToken: true, pages: [], missingScopes: [] },
          pages: [],
        };
        stateCache.set(cacheKey, { result, timestamp: Date.now() });
        return { ...result, cached: false };
      }
      if (err.isRateLimit) {
        result = {
          state: CONNECTION_STATES.RATE_LIMITED,
          details: { hasToken: true, pages: [], missingScopes: [] },
          pages: [],
        };
        stateCache.set(cacheKey, { result, timestamp: Date.now() });
        return { ...result, cached: false };
      }
      throw err; // unexpected — will be caught by outer try/catch
    }

    // Step 4: Fetch pages
    const pages = await listManagedPages(userAccessToken);

    if (pages.length === 0) {
      result = {
        state: CONNECTION_STATES.NO_PAGE,
        details: { hasToken: true, pages: [], missingScopes: [] },
        pages: [],
      };
      stateCache.set(cacheKey, { result, timestamp: Date.now() });
      return { ...result, cached: false };
    }

    // Step 5: Get per-page detailed status
    const pageDetails = await Promise.all(
      pages.map((p) => getPageDetailedStatus(p, userAccessToken))
    );

    // Step 6: Check permissions
    const { granted, declined } = await detectMissingScopes(userAccessToken);

    // Check if publish-critical scopes are missing
    const publishCritical = PUBLISH_SCOPES.filter(
      (s) => !granted.includes(s)
    );

    if (publishCritical.length > 0) {
      result = {
        state: CONNECTION_STATES.PERMISSIONS_MISSING,
        details: {
          hasToken: true,
          pages: pageDetails,
          missingScopes: publishCritical,
          grantedScopes: granted,
          declinedScopes: declined,
        },
        pages: pageDetails,
      };
      stateCache.set(cacheKey, { result, timestamp: Date.now() });
      return { ...result, cached: false };
    }

    // Step 7: Determine overall state from per-page statuses
    const hasAnyIgReady = pageDetails.some(
      (p) => p.instagram?.isProfessional === true
    );
    const allNoIg = pageDetails.every(
      (p) => p.instagram?.linked === false
    );
    const allIgPersonal = pageDetails.every(
      (p) => p.instagram?.linked === true && p.instagram?.isProfessional === false
    );

    // If at least one page is fully publishable (FB always works, IG ready on at least one)
    // → READY_TO_PUBLISH. Per-page details let frontend show granular issues.
    if (hasAnyIgReady || !allIgPersonal) {
      // At least one page can publish to FB; IG may or may not be ready per-page
      result = {
        state: CONNECTION_STATES.READY_TO_PUBLISH,
        details: {
          hasToken: true,
          pages: pageDetails,
          missingScopes: [],
          grantedScopes: granted,
        },
        pages: pageDetails,
      };
      stateCache.set(cacheKey, { result, timestamp: Date.now() });
      return { ...result, cached: false };
    }

    // All pages have IG but all are personal
    if (allIgPersonal) {
      result = {
        state: CONNECTION_STATES.IG_PERSONAL,
        details: {
          hasToken: true,
          pages: pageDetails,
          missingScopes: [],
          grantedScopes: granted,
        },
        pages: pageDetails,
      };
      stateCache.set(cacheKey, { result, timestamp: Date.now() });
      return { ...result, cached: false };
    }

    // All pages have no IG linked
    if (allNoIg) {
      result = {
        state: CONNECTION_STATES.PAGE_EXISTS_NO_IG,
        details: {
          hasToken: true,
          pages: pageDetails,
          missingScopes: [],
          grantedScopes: granted,
        },
        pages: pageDetails,
      };
      stateCache.set(cacheKey, { result, timestamp: Date.now() });
      return { ...result, cached: false };
    }

    // Fallback — pages exist, FB can publish
    result = {
      state: CONNECTION_STATES.READY_TO_PUBLISH,
      details: {
        hasToken: true,
        pages: pageDetails,
        missingScopes: [],
        grantedScopes: granted,
      },
      pages: pageDetails,
    };
    stateCache.set(cacheKey, { result, timestamp: Date.now() });
    return { ...result, cached: false };
  } catch (err) {
    // Catch-all: network failures, Meta 500s, unexpected errors
    if (err.isRateLimit) {
      result = {
        state: CONNECTION_STATES.RATE_LIMITED,
        details: { hasToken: true, pages: [], missingScopes: [] },
        pages: [],
      };
      stateCache.set(cacheKey, { result, timestamp: Date.now() });
      return { ...result, cached: false };
    }
    if (err.isAuthError) {
      result = {
        state: CONNECTION_STATES.TOKEN_EXPIRED,
        details: { hasToken: true, pages: [], missingScopes: [] },
        pages: [],
      };
      stateCache.set(cacheKey, { result, timestamp: Date.now() });
      return { ...result, cached: false };
    }

    logger.error("[meta] connection state detection failed", {
      userId,
      error: err.message,
    });

    // Don't cache errors — let the user retry immediately
    return {
      state: CONNECTION_STATES.DETECTION_ERROR,
      details: { hasToken: false, pages: [], missingScopes: [] },
      pages: [],
      cached: false,
    };
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
  canAccountPublish,
  decryptToken,
  graphFetch,
  subscribePageToWebhooks,
  detectConnectionState,
  detectMissingScopes,
  getPageDetailedStatus,
  invalidateStateCache,
  SCOPES,
  CONNECT_SCOPES,
  PUBLISH_SCOPES,
  ALL_SCOPES,
};
