const crypto = require("crypto");
const { google } = require("googleapis");
const env = require("../config/env");
const ApiError = require("../core/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const logger = require("../core/logger");
const { encrypt, decrypt } = require("../core/tokenEncryption");
const GbpAccount = require("../modules/seo/gbpAccount.model");

// GBP OAuth scopes
const SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
];

// State token lifetime: 15 minutes
const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Ensure Google OAuth env vars are configured.
 */
function ensureConfigured() {
  if (!env.google.clientId || !env.google.clientSecret) {
    throw new ApiError(501, "Google Business Profile OAuth is not configured on this server.", {
      code: ERROR_CODES.GBP_NOT_CONFIGURED,
    });
  }
  if (!env.encryption.tokenKey1) {
    throw new ApiError(501, "Token encryption key is not configured.", {
      code: ERROR_CODES.GBP_NOT_CONFIGURED,
    });
  }
}

/**
 * Create a new OAuth2 client instance.
 */
function createOAuth2Client() {
  return new google.auth.OAuth2(
    env.google.clientId,
    env.google.clientSecret,
    env.google.redirectUri
  );
}

// ─── CSRF State Token ────────────────────────────────────────────────────────

/**
 * Build a signed state token for CSRF protection.
 * Format: base64url(userId.timestamp.nonce.hmacSignature)
 */
function buildState(userId) {
  const secret = env.google.clientSecret;
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = `${userId}.${Date.now()}.${nonce}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

/**
 * Verify and decode a state token. Throws ApiError on invalid/expired state.
 */
function verifyState(state) {
  let decoded;
  try {
    decoded = Buffer.from(String(state || ""), "base64url").toString("utf8");
  } catch {
    throw new ApiError(400, "Invalid OAuth state.", { code: "GBP_OAUTH_FAILED" });
  }
  const parts = decoded.split(".");
  if (parts.length !== 4) {
    throw new ApiError(400, "Invalid OAuth state.", { code: "GBP_OAUTH_FAILED" });
  }
  const [userId, ts, nonce, sig] = parts;
  const expected = crypto
    .createHmac("sha256", env.google.clientSecret)
    .update(`${userId}.${ts}.${nonce}`)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(400, "Invalid OAuth state signature.", { code: "GBP_OAUTH_FAILED" });
  }
  if (Date.now() - Number(ts) > STATE_TTL_MS) {
    throw new ApiError(400, "OAuth state expired. Please try again.", { code: "GBP_OAUTH_FAILED" });
  }
  return { userId };
}

// ─── OAuth Flow ──────────────────────────────────────────────────────────────

/**
 * Generate the Google OAuth consent URL.
 */
function getConsentUrl(userId) {
  ensureConfigured();
  const state = buildState(userId);
  const oauth2Client = createOAuth2Client();

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });

  return { url, state };
}

/**
 * Exchange authorization code for tokens.
 * Returns { accessToken, refreshToken, tokenExpiry, scopes }.
 */
async function exchangeCode(code) {
  ensureConfigured();
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new ApiError(400, "Google did not return required tokens. Please try connecting again.", {
      code: ERROR_CODES.GBP_OAUTH_FAILED,
    });
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600 * 1000),
    scopes: tokens.scope ? tokens.scope.split(" ") : SCOPES,
  };
}

/**
 * Refresh an expired access token using the stored refresh token.
 * Updates the GbpAccount document with the new encrypted access token + expiry.
 */
async function refreshAccessToken(gbpAccount) {
  ensureConfigured();
  const oauth2Client = createOAuth2Client();
  const refreshToken = decrypt(gbpAccount.refreshToken);

  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const { credentials } = await oauth2Client.refreshAccessToken();

  if (!credentials.access_token) {
    // Mark as expired — user needs to reconnect
    gbpAccount.status = "expired";
    await gbpAccount.save();
    throw new ApiError(401, "Google token refresh failed. Please reconnect your Google Business Profile.", {
      code: ERROR_CODES.GBP_OAUTH_FAILED,
    });
  }

  gbpAccount.accessToken = encrypt(credentials.access_token);
  gbpAccount.tokenExpiry = credentials.expiry_date
    ? new Date(credentials.expiry_date)
    : new Date(Date.now() + 3600 * 1000);
  gbpAccount.status = "connected";
  await gbpAccount.save();

  return credentials.access_token;
}

/**
 * Get a valid (non-expired) access token for a GbpAccount.
 * Refreshes automatically if expired.
 */
async function getValidAccessToken(gbpAccount) {
  if (gbpAccount.status === "revoked") {
    throw new ApiError(401, "Google connection was revoked. Please reconnect.", {
      code: ERROR_CODES.GBP_NOT_CONNECTED,
    });
  }

  // If token is still valid (with 5-minute buffer), decrypt and return
  if (gbpAccount.tokenExpiry && gbpAccount.tokenExpiry.getTime() > Date.now() + 5 * 60 * 1000) {
    return decrypt(gbpAccount.accessToken);
  }

  // Token expired — refresh it
  return refreshAccessToken(gbpAccount);
}

// ─── GBP Account & Location Fetching ────────────────────────────────────────

/**
 * List the user's GBP accounts using the My Business Account Management API.
 */
async function listAccounts(accessToken) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });

  const mybusinessaccountmanagement = google.mybusinessaccountmanagement({
    version: "v1",
    auth: oauth2Client,
  });

  const allAccounts = [];
  let pageToken;
  do {
    const res = await mybusinessaccountmanagement.accounts.list({
      pageToken,
    });
    allAccounts.push(...(res.data.accounts || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return allAccounts.map((a) => ({
    accountId: a.name,       // "accounts/123456789"
    accountName: a.accountName || a.name,
    type: a.type,
  }));
}

/**
 * List locations for a given GBP account.
 */
async function listLocations(accessToken, accountId) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });

  const mybusinessbusinessinformation = google.mybusinessbusinessinformation({
    version: "v1",
    auth: oauth2Client,
  });

  const allLocations = [];
  let pageToken;
  do {
    const res = await mybusinessbusinessinformation.accounts.locations.list({
      parent: accountId,
      readMask: "name,title,storefrontAddress",
      pageToken,
    });
    allLocations.push(...(res.data.locations || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return allLocations.map((loc) => ({
    locationId: loc.name,     // "accounts/123/locations/456"
    locationName: loc.title || loc.name,
    address: loc.storefrontAddress
      ? [
          loc.storefrontAddress.addressLines?.join(", "),
          loc.storefrontAddress.locality,
          loc.storefrontAddress.administrativeArea,
        ]
          .filter(Boolean)
          .join(", ")
      : "",
  }));
}

// ─── Connect / Save / Disconnect ────────────────────────────────────────────

/**
 * Helper: check if an error is a Google API rate limit (429 / quota exceeded).
 */
function isRateLimitError(err) {
  return (
    err.code === 429 ||
    err.status === 429 ||
    (err.message && err.message.includes("Quota exceeded"))
  );
}

/**
 * After OAuth callback: save tokens FIRST, then try to fetch accounts + locations.
 * If Google API calls fail with rate limits, tokens are already persisted so the
 * user can retry via fetchLocationsForBusiness without re-doing OAuth.
 */
async function connectAndFetchLocations(userId, businessId, tokenData) {
  const { accessToken, refreshToken, tokenExpiry, scopes } = tokenData;

  // ── Step 1: Save tokens to DB immediately (before any Google API calls) ──
  const encAccessToken = encrypt(accessToken);
  const encRefreshToken = encrypt(refreshToken);

  await GbpAccount.findOneAndUpdate(
    { businessId },
    {
      $set: {
        userId,
        businessId,
        accessToken: encAccessToken,
        refreshToken: encRefreshToken,
        tokenExpiry,
        scopes,
        encryptionVersion: env.encryption.currentVersion,
        connectedAt: new Date(),
        status: "pending_locations",
        gbpAccountId: "",
        gbpAccountName: "",
        gbpLocationId: "",
        gbpLocationName: "",
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );

  logger.info("[gbp] tokens saved, fetching accounts/locations", { businessId });

  // ── Step 2: Fetch accounts + locations using the plain access token ──
  return _fetchAndFinalise(businessId, accessToken);
}

/**
 * Retry fetching GBP accounts/locations for a business that already has saved tokens.
 * Used when the initial fetch failed (e.g. rate limit) but tokens are persisted.
 */
async function fetchLocationsForBusiness(businessId) {
  const gbpAccount = await GbpAccount.findOne({ businessId });
  if (!gbpAccount) {
    throw new ApiError(404, "No Google connection found. Please connect first.", {
      code: ERROR_CODES.GBP_NOT_CONNECTED,
    });
  }

  // If locations are already fetched and a location is selected, return status
  if (gbpAccount.status === "connected" && gbpAccount.gbpLocationId) {
    return {
      accounts: [],
      locations: [],
      gbpAccount: gbpAccount,
      autoConnected: true,
      alreadyComplete: true,
    };
  }

  // Decrypt the saved access token
  let accessToken;
  try {
    accessToken = decrypt(gbpAccount.accessToken);
  } catch {
    throw new ApiError(401, "Stored token is invalid. Please reconnect Google Business Profile.", {
      code: ERROR_CODES.GBP_OAUTH_FAILED,
    });
  }

  // If token is expired, try refreshing first
  if (gbpAccount.tokenExpiry && gbpAccount.tokenExpiry.getTime() < Date.now() + 60 * 1000) {
    accessToken = await refreshAccessToken(gbpAccount);
  }

  return _fetchAndFinalise(gbpAccount.businessId, accessToken);
}

/**
 * Internal: fetch Google accounts + locations and update the GbpAccount doc.
 * Throws GBP_RATE_LIMITED (429) if Google API quota is hit — tokens stay saved.
 */
async function _fetchAndFinalise(businessId, accessToken) {
  let accounts;
  try {
    accounts = await listAccounts(accessToken);
  } catch (err) {
    if (isRateLimitError(err)) {
      throw new ApiError(429, "Google API rate limit reached. Your connection is saved — please tap 'Retry' in a minute.", {
        code: ERROR_CODES.GBP_RATE_LIMITED,
      });
    }
    throw err;
  }

  if (accounts.length === 0) {
    throw new ApiError(400, "No Google Business Profile found for this Google account. Please create one on Google first.", {
      code: ERROR_CODES.GBP_ACCOUNT_NOT_FOUND,
    });
  }

  let allLocations = [];
  try {
    for (const account of accounts) {
      const locations = await listLocations(accessToken, account.accountId);
      allLocations.push(
        ...locations.map((loc) => ({
          ...loc,
          accountId: account.accountId,
          accountName: account.accountName,
        }))
      );
    }
  } catch (err) {
    if (isRateLimitError(err)) {
      throw new ApiError(429, "Google API rate limit reached. Your connection is saved — please tap 'Retry' in a minute.", {
        code: ERROR_CODES.GBP_RATE_LIMITED,
      });
    }
    throw err;
  }

  if (allLocations.length === 0) {
    throw new ApiError(400, "No business locations found in your Google Business Profile. Please add a location on Google first.", {
      code: ERROR_CODES.GBP_ACCOUNT_NOT_FOUND,
    });
  }

  // Update status and auto-select if single location
  const gbpAccountDoc = await GbpAccount.findOneAndUpdate(
    { businessId },
    {
      $set: {
        status: "connected",
        gbpAccountId: allLocations.length === 1 ? allLocations[0].accountId : "",
        gbpAccountName: allLocations.length === 1 ? allLocations[0].accountName : "",
        gbpLocationId: allLocations.length === 1 ? allLocations[0].locationId : "",
        gbpLocationName: allLocations.length === 1 ? allLocations[0].locationName : "",
      },
    },
    { returnDocument: "after" }
  );

  return {
    accounts,
    locations: allLocations,
    gbpAccount: gbpAccountDoc,
    autoConnected: allLocations.length === 1,
  };
}

/**
 * User picks a location from the picker (when multiple locations exist).
 * Accepts the location metadata directly from the controller to avoid
 * redundant Google API calls (the locations were already fetched during connect).
 */
async function selectLocation(businessId, locationId, locationMeta) {
  const gbpAccount = await GbpAccount.findOne({ businessId });
  if (!gbpAccount) {
    throw new ApiError(404, "No Google connection found. Please connect first.", {
      code: ERROR_CODES.GBP_NOT_CONNECTED,
    });
  }

  if (!locationId) {
    throw new ApiError(400, "locationId is required.", {
      code: ERROR_CODES.GBP_ACCOUNT_NOT_FOUND,
    });
  }

  // Use metadata passed from the picker (originally fetched during connect)
  // instead of making additional Google API calls.
  gbpAccount.gbpLocationId = locationId;
  gbpAccount.gbpLocationName = locationMeta?.locationName || locationId;
  gbpAccount.gbpAccountId = locationMeta?.accountId || gbpAccount.gbpAccountId || "";
  gbpAccount.gbpAccountName = locationMeta?.accountName || gbpAccount.gbpAccountName || "";
  await gbpAccount.save();

  return gbpAccount;
}

/**
 * Disconnect GBP — removes tokens from MongoDB.
 */
async function disconnect(businessId) {
  const result = await GbpAccount.findOneAndDelete({ businessId });
  if (!result) {
    logger.info("[gbpOAuth] disconnect — no GBP connection found", { businessId });
  }
  return !!result;
}

/**
 * Get the current GBP connection status for a business.
 */
async function getStatus(businessId) {
  const gbpAccount = await GbpAccount.findOne({ businessId }).select(
    "status gbpLocationName gbpAccountName connectedAt gbpLocationId"
  );

  if (!gbpAccount) {
    return { connected: false };
  }

  return {
    connected: gbpAccount.status === "connected",
    status: gbpAccount.status,
    locationName: gbpAccount.gbpLocationName || "",
    accountName: gbpAccount.gbpAccountName || "",
    locationSelected: !!gbpAccount.gbpLocationId,
    connectedAt: gbpAccount.connectedAt,
  };
}

module.exports = {
  ensureConfigured,
  getConsentUrl,
  verifyState,
  exchangeCode,
  refreshAccessToken,
  getValidAccessToken,
  listAccounts,
  listLocations,
  connectAndFetchLocations,
  fetchLocationsForBusiness,
  selectLocation,
  disconnect,
  getStatus,
  SCOPES,
};
