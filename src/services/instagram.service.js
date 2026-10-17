const crypto = require("crypto");
const env = require("../config/env");
const ApiError = require("../core/ApiError");
const logger = require("../core/logger");

// Instagram Business Login scopes
const SCOPES = (env.instagram.scopes || "").split(",").map((s) => s.trim());

const ensureConfigured = () => {
  if (!env.instagram.appId || !env.instagram.appSecret) {
    throw new ApiError(501, "Instagram OAuth is not configured on this server.");
  }
};

// ── CSRF state helpers (same pattern as linkedin.service) ───────────────────
const usedNonces = new Map();
const NONCE_TTL_MS = 15 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - NONCE_TTL_MS;
  for (const [nonce, ts] of usedNonces) {
    if (ts < cutoff) usedNonces.delete(nonce);
  }
}, 5 * 60 * 1000).unref();

const buildState = (userId) => {
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = `${userId}.${Date.now()}.${nonce}`;
  const sig = crypto
    .createHmac("sha256", env.instagram.oauthStateSecret)
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
    .createHmac("sha256", env.instagram.oauthStateSecret)
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

  if (usedNonces.has(nonce)) {
    throw new ApiError(400, "OAuth state already consumed.");
  }
  usedNonces.set(nonce, Date.now());

  return { userId };
};

// ── OAuth URL ───────────────────────────────────────────────────────────────
const getAuthorizeUrl = (userId) => {
  ensureConfigured();
  const state = buildState(userId);
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("enable_fb_login", "0");
  url.searchParams.set("force_reauth", "true");
  url.searchParams.set("client_id", env.instagram.appId);
  url.searchParams.set("redirect_uri", env.instagram.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
};

// ── Token exchange (code → short-lived token) ───────────────────────────────
const exchangeCodeForToken = async (code) => {
  ensureConfigured();
  const res = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.instagram.appId,
      client_secret: env.instagram.appSecret,
      grant_type: "authorization_code",
      redirect_uri: env.instagram.redirectUri,
      code,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    logger.error("Instagram token exchange failed", {
      status: res.status,
      error: data.error_message || data.error_type || JSON.stringify(data),
    });
    throw new ApiError(
      400,
      data.error_message || "Instagram token exchange failed."
    );
  }
  return {
    accessToken: data.access_token,
    userId: String(data.user_id),
  };
};

// ── Exchange short-lived → long-lived token (60 days) ───────────────────────
const getLongLivedToken = async (shortLivedToken) => {
  ensureConfigured();
  const url = new URL("https://graph.instagram.com/access_token");
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", env.instagram.appSecret);
  url.searchParams.set("access_token", shortLivedToken);

  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    logger.error("Instagram long-lived token exchange failed", {
      status: res.status,
      error: data.error?.message || JSON.stringify(data),
    });
    throw new ApiError(
      400,
      data.error?.message || "Failed to obtain long-lived Instagram token."
    );
  }
  return {
    accessToken: data.access_token,
    tokenType: data.token_type,
    expiresIn: data.expires_in || null, // seconds (typically 5184000 = 60 days)
  };
};

// ── Refresh long-lived token (must be called before expiry) ─────────────────
const refreshLongLivedToken = async (validLongLivedToken) => {
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", validLongLivedToken);

  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    logger.error("Instagram token refresh failed", {
      status: res.status,
      error: data.error?.message || JSON.stringify(data),
    });
    throw new ApiError(
      400,
      data.error?.message || "Failed to refresh Instagram token."
    );
  }
  return {
    accessToken: data.access_token,
    tokenType: data.token_type,
    expiresIn: data.expires_in || null,
  };
};

// ── Fetch profile ───────────────────────────────────────────────────────────
const getProfile = async (accessToken) => {
  const url = new URL("https://graph.instagram.com/v22.0/me");
  url.searchParams.set(
    "fields",
    "user_id,username,name,profile_picture_url,account_type"
  );
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok || data.error) {
    logger.error("Instagram profile fetch failed", {
      status: res.status,
      error: data.error?.message || JSON.stringify(data),
    });
    throw new ApiError(
      400,
      data.error?.message || "Failed to fetch Instagram profile."
    );
  }
  return {
    userId: String(data.user_id || data.id),
    username: data.username || "",
    name: data.name || "",
    profilePictureUrl: data.profile_picture_url || "",
    accountType: data.account_type || "",
  };
};

// ── Publishing ──────────────────────────────────────────────────────────────
// Instagram Login issues tokens for graph.instagram.com. They are rejected by
// graph.facebook.com with code 190, which reads as "token expired" even on a
// token minted seconds earlier — so these accounts must publish through here
// rather than through meta.service.
const IG_GRAPH = "https://graph.instagram.com/v22.0";

// Mirrors meta.service's error shape so postPublisher's classifyFailure can
// branch on it without knowing which service produced the error.
const igError = (data, status) => {
  const code = data?.error?.code;
  const message =
    data?.error?.message || `Instagram API request failed (HTTP ${status}).`;
  const err = new Error(message);
  err.metaCode = code;
  err.statusCode = status;
  err.isRateLimit = code === 4 || code === 17 || code === 341 || status === 429;
  err.isAuthError = code === 190;
  if (err.isRateLimit || status >= 500) err.failureType = "retryable";
  else if (err.isAuthError || code === 200 || code === 10) err.failureType = "recoverable";
  else if (code === 368 || code === 2207051) err.failureType = "permanent";
  else if (code === 100) err.failureType = "permanent";
  else err.failureType = "retryable";
  return err;
};

const igGet = async (path, searchParams) => {
  const url = new URL(`${IG_GRAPH}${path}`);
  Object.entries(searchParams).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw igError(data, res.status);
  return data;
};

const igFetch = async (path, searchParams) => {
  const url = new URL(`${IG_GRAPH}${path}`);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(searchParams).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw igError(data, res.status);
  return data;
};

// Creating a container only queues it — Instagram still has to fetch the
// image from our server. Publishing before that finishes returns code 9007,
// "Media ID is not available", which reads like a bad id but just means too
// soon. Poll until the container is ready.
const CONTAINER_POLL_MS = 2000;
const CONTAINER_MAX_WAIT_MS = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitForContainer = async (containerId, accessToken) => {
  const deadline = Date.now() + CONTAINER_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    const data = await igGet(`/${containerId}`, {
      fields: "status_code,status",
      access_token: accessToken,
    });

    if (data.status_code === "FINISHED") return;

    if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
      // Almost always an image Instagram could not fetch or accept, which no
      // amount of retrying will fix.
      const err = new Error(
        data.status ||
          `Instagram rejected the media (${data.status_code}). Check the image is publicly reachable, JPEG, and within size limits.`
      );
      err.failureType = "permanent";
      throw err;
    }

    await sleep(CONTAINER_POLL_MS);
  }

  const err = new Error("Instagram did not finish processing the image in time.");
  err.failureType = "retryable";
  throw err;
};

// An account connected through Instagram Login, as opposed to one reached via
// a linked Facebook Page. The two grant different scope names for the same
// permissions, which is the only thing that distinguishes them on the record.
const isInstagramLoginAccount = (account) =>
  (account?.grantedScopes || []).some((x) => x.startsWith("instagram_business_"));

// permalink is a stable public URL for the post. mediaUrl is Instagram's CDN
// copy of the image — handy, but Meta serves it from signed URLs that expire,
// so it must never be the only copy anything depends on.
const getMediaInfo = async (mediaId, accessToken) => {
  const data = await igGet(`/${mediaId}`, {
    fields: "permalink,media_url,media_type",
    access_token: accessToken,
  });
  return {
    permalink: data.permalink || "",
    mediaUrl: data.media_url || "",
    mediaType: data.media_type || "",
  };
};

const publish = async ({ account, content }) => {
  if (!account.accessToken) {
    throw new Error("Instagram account has no access token. Reconnect required.");
  }
  if (!account.accountId) {
    throw new Error("Instagram account is missing its user id. Reconnect required.");
  }
  if (!content.imageUrl) {
    throw new Error("Instagram requires an image to publish.");
  }

  const accessToken = require("./meta.service").decryptToken(account.accessToken);

  // Two-step: build a media container, then publish it.
  const container = await igFetch(`/${account.accountId}/media`, {
    image_url: content.imageUrl,
    caption: content.caption || "",
    access_token: accessToken,
  });
  if (!container.id) throw new Error("Failed to create Instagram media container.");

  await waitForContainer(container.id, accessToken);

  const published = await igFetch(`/${account.accountId}/media_publish`, {
    creation_id: container.id,
    access_token: accessToken,
  });

  // The media id alone is not a web address — instagram.com/<id> is a dead
  // link. The real permalink has to be read back from the API.
  const info = await getMediaInfo(published.id, accessToken).catch(() => ({}));

  return {
    externalPostId: published.id,
    permalink: info.permalink || "",
    mediaUrl: info.mediaUrl || "",
  };
};

module.exports = {
  SCOPES,
  publish,
  getMediaInfo,
  isInstagramLoginAccount,
  ensureConfigured,
  buildState,
  verifyState,
  getAuthorizeUrl,
  exchangeCodeForToken,
  getLongLivedToken,
  refreshLongLivedToken,
  getProfile,
};
