const crypto = require("crypto");
const { google } = require("googleapis");
const env = require("../../config/env");
const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const User = require("../user/user.model");
const authService = require("./auth.service");

const STATE_TTL_MS = 15 * 60 * 1000;
const STATE_SECRET = env.jwtSecret;

// ── One-time nonce tracking ─────────────────────────────────────────────────
const usedNonces = new Map();
setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [nonce, ts] of usedNonces) {
    if (ts < cutoff) usedNonces.delete(nonce);
  }
}, 5 * 60 * 1000).unref();

// ── State token helpers ─────────────────────────────────────────────────────
function buildState(provider) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = `${provider}.${Date.now()}.${nonce}`;
  const sig = crypto.createHmac("sha256", STATE_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

function verifyState(state) {
  let decoded;
  try {
    decoded = Buffer.from(String(state || ""), "base64url").toString("utf8");
  } catch {
    throw new ApiError(400, "Invalid OAuth state.");
  }
  const parts = decoded.split(".");
  if (parts.length !== 4) throw new ApiError(400, "Invalid OAuth state.");

  const [provider, ts, nonce, sig] = parts;
  const payload = `${provider}.${ts}.${nonce}`;
  const expected = crypto.createHmac("sha256", STATE_SECRET).update(payload).digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(400, "Invalid OAuth state signature.");
  }
  if (Date.now() - Number(ts) > STATE_TTL_MS) {
    throw new ApiError(400, "OAuth state expired. Please try again.");
  }
  if (usedNonces.has(nonce)) {
    throw new ApiError(400, "OAuth state already consumed.");
  }
  usedNonces.set(nonce, Date.now());

  return { provider };
}

// ── Google Login ────────────────────────────────────────────────────────────

function createGoogleAuthClient() {
  return new google.auth.OAuth2(
    env.google.clientId,
    env.google.clientSecret,
    env.google.authRedirectUri
  );
}

function getGoogleLoginUrl() {
  if (!env.google.clientId || !env.google.clientSecret) {
    throw new ApiError(501, "Google OAuth is not configured.");
  }
  const state = buildState("google");
  const oauth2Client = createGoogleAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "select_account",
    scope: ["openid", "email", "profile"],
    state,
  });
  return { url, state };
}

async function exchangeGoogleLogin({ code, state, device }) {
  const { provider } = verifyState(state);
  if (provider !== "google") throw new ApiError(400, "State mismatch.");

  const oauth2Client = createGoogleAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.id_token) {
    throw new ApiError(400, "Google did not return an ID token.");
  }

  // Verify and decode the ID token
  const ticket = await oauth2Client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.google.clientId,
  });
  const payload = ticket.getPayload();
  const googleId = payload.sub;
  const email = payload.email;
  const name = payload.name || payload.email;
  const avatarUrl = payload.picture || null;

  if (!email) {
    throw new ApiError(400, "Google account does not have an email address.");
  }

  // Find existing user by googleId or email
  let user = await User.findOne({ googleId });

  if (!user) {
    user = await User.findOne({ email });
    if (user) {
      // Link Google to existing account
      user.googleId = googleId;
      if (avatarUrl && !user.avatarUrl) user.avatarUrl = avatarUrl;
      if (!user.isEmailVerified) user.isEmailVerified = true;
      user.lastLoginAt = new Date();
      await user.save();
    } else {
      // Create new user
      user = await User.create({
        name,
        email,
        googleId,
        avatarUrl,
        isEmailVerified: true,
      });
    }
  } else {
    user.lastLoginAt = new Date();
    if (avatarUrl && !user.avatarUrl) user.avatarUrl = avatarUrl;
    await user.save();
  }

  return authService.buildSession(user, device);
}

// ── Meta Login ──────────────────────────────────────────────────────────────

function getMetaLoginUrl() {
  if (!env.meta.appId || !env.meta.appSecret) {
    throw new ApiError(501, "Meta OAuth is not configured.");
  }
  const state = buildState("meta");
  const url = new URL("https://www.facebook.com/dialog/oauth");
  url.searchParams.set("client_id", env.meta.appId);
  url.searchParams.set("redirect_uri", env.meta.authRedirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "public_profile,email");
  return { url: url.toString(), state };
}

async function exchangeMetaLogin({ code, state, device }) {
  const { provider } = verifyState(state);
  if (provider !== "meta") throw new ApiError(400, "State mismatch.");

  // Exchange code for access token
  const tokenUrl = new URL(`https://graph.facebook.com/${env.meta.graphVersion}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", env.meta.appId);
  tokenUrl.searchParams.set("client_secret", env.meta.appSecret);
  tokenUrl.searchParams.set("redirect_uri", env.meta.authRedirectUri);
  tokenUrl.searchParams.set("code", code);

  const tokenRes = await fetch(tokenUrl);
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new ApiError(400, "Failed to exchange Meta authorization code.");
  }

  // Fetch user profile
  const profileUrl = new URL(`https://graph.facebook.com/${env.meta.graphVersion}/me`);
  profileUrl.searchParams.set("access_token", tokenData.access_token);
  profileUrl.searchParams.set("fields", "id,name,email,picture.type(large)");

  const profileRes = await fetch(profileUrl);
  const profile = await profileRes.json();
  if (!profileRes.ok || !profile.id) {
    throw new ApiError(400, "Failed to fetch Meta profile.");
  }

  const metaId = profile.id;
  const email = profile.email;
  const name = profile.name || "User";
  const avatarUrl = profile.picture?.data?.url || null;

  if (!email) {
    throw new ApiError(400, "Your Meta account does not have an email address, or email permission was not granted.");
  }

  // Find existing user by metaId or email
  let user = await User.findOne({ metaId });

  if (!user) {
    user = await User.findOne({ email });
    if (user) {
      // Link Meta to existing account
      user.metaId = metaId;
      if (avatarUrl && !user.avatarUrl) user.avatarUrl = avatarUrl;
      if (!user.isEmailVerified) user.isEmailVerified = true;
      user.lastLoginAt = new Date();
      await user.save();
    } else {
      // Create new user
      user = await User.create({
        name,
        email,
        metaId,
        avatarUrl,
        isEmailVerified: true,
      });
    }
  } else {
    user.lastLoginAt = new Date();
    if (avatarUrl && !user.avatarUrl) user.avatarUrl = avatarUrl;
    await user.save();
  }

  return authService.buildSession(user, device);
}

module.exports = {
  getGoogleLoginUrl,
  exchangeGoogleLogin,
  getMetaLoginUrl,
  exchangeMetaLogin,
};
