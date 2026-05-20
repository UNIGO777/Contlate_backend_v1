const crypto = require("crypto");
const env = require("../config/env");
const ApiError = require("../core/ApiError");

// LinkedIn OAuth 2.0 — using the new OpenID + r_liteprofile + w_member_social scopes
const SCOPES = ["openid", "profile", "email", "w_member_social"];

const ensureConfigured = () => {
  if (!env.linkedin.clientId || !env.linkedin.clientSecret) {
    throw new ApiError(501, "LinkedIn OAuth is not configured on this server.");
  }
};

// ── CSRF state helpers (same pattern as meta.service) ──────────────────────────
const buildState = (userId) => {
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = `${userId}.${Date.now()}.${nonce}`;
  const sig = crypto
    .createHmac("sha256", env.linkedin.oauthStateSecret)
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
    .createHmac("sha256", env.linkedin.oauthStateSecret)
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

// ── OAuth URL ─────────────────────────────────────────────────────────────────
const getAuthorizeUrl = (userId) => {
  ensureConfigured();
  const state = buildState(userId);
  const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.linkedin.clientId);
  url.searchParams.set("redirect_uri", env.linkedin.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", SCOPES.join(" "));
  return { url: url.toString(), state };
};

// ── Token exchange ────────────────────────────────────────────────────────────
const exchangeCodeForToken = async (code) => {
  ensureConfigured();
  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: env.linkedin.redirectUri,
      client_id: env.linkedin.clientId,
      client_secret: env.linkedin.clientSecret,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new ApiError(400, data.error_description || "LinkedIn token exchange failed.");
  }
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in || null, // seconds
  };
};

// ── Profile (using OpenID userinfo endpoint) ──────────────────────────────────
const getProfile = async (accessToken) => {
  const res = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || "Failed to fetch LinkedIn profile.");
  }
  return {
    sub: data.sub,                              // unique LinkedIn user ID
    name: data.name || data.given_name || "LinkedIn User",
    email: data.email || "",
  };
};

// ── Publish image post via UGC Post API ──────────────────────────────────────
const publishImagePost = async ({ accessToken, authorUrn, imageUrl, caption }) => {
  // Step 1: Register the image asset
  const registerRes = await fetch("https://api.linkedin.com/v2/assets?action=registerUpload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
        owner: authorUrn,
        serviceRelationships: [
          {
            relationshipType: "OWNER",
            identifier: "urn:li:userGeneratedContent",
          },
        ],
      },
    }),
  });
  const registerData = await registerRes.json();
  if (!registerRes.ok) {
    throw new Error(registerData.message || "LinkedIn image register failed.");
  }

  const uploadUrl =
    registerData.value?.uploadMechanism?.[
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ]?.uploadUrl;
  const asset = registerData.value?.asset;

  if (!uploadUrl || !asset) {
    throw new Error("LinkedIn did not return an upload URL.");
  }

  // Step 2: Upload image binary
  const imgRes = await fetch(imageUrl);
  const imgBuffer = await imgRes.arrayBuffer();

  await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "image/jpeg" },
    body: imgBuffer,
  });

  // Step 3: Create UGC post
  const postRes = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: caption || "" },
          shareMediaCategory: "IMAGE",
          media: [
            {
              status: "READY",
              description: { text: caption || "" },
              media: asset,
              title: { text: "" },
            },
          ],
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
  });
  const postData = await postRes.json();
  if (!postRes.ok) {
    throw new Error(postData.message || "LinkedIn UGC post creation failed.");
  }

  return { externalPostId: postData.id || "" };
};

module.exports = {
  getAuthorizeUrl,
  verifyState,
  exchangeCodeForToken,
  getProfile,
  publishImagePost,
  SCOPES,
};
