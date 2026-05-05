const crypto = require("crypto");
const env = require("../config/env");
const ApiError = require("../core/ApiError");
const logger = require("../core/logger");

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

const graphFetch = async (path, { method = "GET", searchParams, body } = {}) => {
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
    const err = new Error(json?.error?.message || `Graph API error (${res.status}).`);
    err.statusCode = res.status;
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

const publish = async ({ account, content }) => {
  if (!account.accessToken) {
    throw new Error("Social account has no access token. Reconnect required.");
  }
  if (account.platform === "facebook") {
    return publishToFacebookPage({
      pageId: account.accountId,
      pageAccessToken: account.accessToken,
      imageUrl: content.imageUrl,
      caption: content.caption,
    });
  }
  if (account.platform === "instagram") {
    return publishToInstagram({
      instagramAccountId: account.accountId,
      pageAccessToken: account.accessToken,
      imageUrl: content.imageUrl,
      caption: content.caption,
    });
  }
  throw new Error(`Unsupported platform: ${account.platform}`);
};

module.exports = {
  ensureConfigured,
  getAuthorizeUrl,
  verifyState,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  listManagedPages,
  publish,
  SCOPES,
  logger,
};
