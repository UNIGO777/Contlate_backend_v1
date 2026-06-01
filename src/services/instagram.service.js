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
  url.searchParams.set("force_authentication", "1");
  url.searchParams.set("client_id", env.instagram.appId);
  url.searchParams.set("redirect_uri", env.instagram.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
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

module.exports = {
  SCOPES,
  ensureConfigured,
  buildState,
  verifyState,
  getAuthorizeUrl,
  exchangeCodeForToken,
  getLongLivedToken,
  refreshLongLivedToken,
  getProfile,
};
