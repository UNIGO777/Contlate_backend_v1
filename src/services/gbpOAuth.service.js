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
 * After OAuth callback: save tokens to DB and queue a background job
 * to fetch accounts/locations. Returns immediately — no Google API calls here.
 * The GBP sync worker handles all Google API communication with proper
 * rate limiting, delays, and exponential backoff retries.
 */
async function connectAndSaveTokens(userId, businessId, tokenData) {
  const { accessToken, refreshToken, tokenExpiry, scopes } = tokenData;

  const encAccessToken = encrypt(accessToken);
  const encRefreshToken = encrypt(refreshToken);

  const gbpAccountDoc = await GbpAccount.findOneAndUpdate(
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
        status: "syncing",
        gbpAccountId: "",
        gbpAccountName: "",
        gbpLocationId: "",
        gbpLocationName: "",
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );

  logger.info("[gbp] tokens saved, queuing background sync", { businessId });

  // Queue background job (deduplication: one job per business)
  try {
    const { getQueues } = require("../queues/queues");
    const queues = getQueues();
    await queues.gbpSync.add(
      "sync-locations",
      { businessId: businessId.toString(), userId: userId.toString() },
      {
        jobId: `gbp-sync-${businessId}`, // deduplicate: only one sync per business
        delay: 2000, // 2-second delay before starting (avoid immediate rate limits)
      }
    );
  } catch (queueErr) {
    // If Redis/BullMQ is down, fall back to pending_locations so user can retry manually
    logger.warn("[gbp] failed to queue sync job, falling back to pending_locations", {
      businessId,
      error: queueErr.message,
    });
    gbpAccountDoc.status = "pending_locations";
    await gbpAccountDoc.save();
  }

  return gbpAccountDoc;
}

/**
 * Retry: re-queue a GBP sync job for a business that already has saved tokens.
 * Used when the background sync failed or Redis was down during initial connect.
 */
async function retrySync(businessId) {
  const gbpAccount = await GbpAccount.findOne({ businessId });
  if (!gbpAccount) {
    throw new ApiError(404, "No Google connection found. Please connect first.", {
      code: ERROR_CODES.GBP_NOT_CONNECTED,
    });
  }

  // Already fully connected
  if (gbpAccount.status === "connected" && gbpAccount.gbpLocationId) {
    return { alreadyComplete: true, gbpAccount };
  }

  // Already syncing — but only believe it for a short window. The worker
  // retries with exponential backoff (30s/60s/120s/240s), and getStatus flips
  // a stalled "syncing" to pending_locations after 60s, so a press landing in
  // that gap used to be a silent no-op that still answered 200.
  const SYNC_STALL_MS = 60 * 1000;
  const lastChange = gbpAccount.updatedAt ? gbpAccount.updatedAt.getTime() : 0;
  if (gbpAccount.status === "syncing" && Date.now() - lastChange < SYNC_STALL_MS) {
    return { alreadySyncing: true, gbpAccount };
  }

  // Queue the sync job
  gbpAccount.status = "syncing";
  await gbpAccount.save();

  try {
    const { getQueues } = require("../queues/queues");
    const queues = getQueues();

    // BullMQ de-duplicates on jobId: if a job with this id still exists in
    // ANY state, `add` is silently ignored. The old guard only removed
    // completed/failed jobs, so a job sitting in `delayed` between backoff
    // attempts swallowed every retry press while we still returned 200.
    // Remove it whatever the state, except `active` — that one is mid-run.
    const existingJob = await queues.gbpSync.getJob(`gbp-sync-${businessId}`);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === "active") {
        // Genuinely running right now; let it finish rather than racing it.
        return { alreadySyncing: true, gbpAccount };
      }
      await existingJob.remove().catch(() => {});
      logger.info("[gbp] removed stale sync job before retry", {
        businessId: String(businessId),
        previousState: state,
      });
    }

    await queues.gbpSync.add(
      "sync-locations",
      { businessId: businessId.toString(), userId: gbpAccount.userId.toString() },
      {
        jobId: `gbp-sync-${businessId}`,
        delay: 2000,
      }
    );
  } catch (queueErr) {
    gbpAccount.status = "pending_locations";
    await gbpAccount.save();
    throw new ApiError(503, "Background sync service is temporarily unavailable. Please try again.", {
      code: ERROR_CODES.GBP_RATE_LIMITED,
    });
  }

  return { queued: true, gbpAccount };
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
  gbpAccount.pendingLocations = []; // clear after selection
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
    "_id status gbpLocationName gbpAccountName connectedAt gbpLocationId pendingLocations"
  );

  if (!gbpAccount) {
    return { connected: false };
  }

  // Safety net: if the sync job hasn't completed within SYNC_STALL_MS, treat it
  // as pending_locations (in case the worker failed to update status after all
  // retries) so the client stops polling and shows the retry UI instead of an
  // endless spinner.
  const SYNC_STALL_MS = 60 * 1000;
  let effectiveStatus = gbpAccount.status;
  if (
    effectiveStatus === "syncing" &&
    gbpAccount.connectedAt &&
    Date.now() - gbpAccount.connectedAt.getTime() > SYNC_STALL_MS
  ) {
    effectiveStatus = "pending_locations";
    // Also update the DB so it doesn't keep returning syncing
    GbpAccount.updateOne(
      { _id: gbpAccount._id, status: "syncing" },
      { $set: { status: "pending_locations" } }
    ).catch(() => {});
  }

  const result = {
    connected: effectiveStatus === "connected",
    syncing: effectiveStatus === "syncing",
    status: effectiveStatus,
    locationName: gbpAccount.gbpLocationName || "",
    accountName: gbpAccount.gbpAccountName || "",
    locationSelected: !!gbpAccount.gbpLocationId,
    connectedAt: gbpAccount.connectedAt,
  };

  // Include pending locations if user needs to pick one
  if (
    effectiveStatus === "connected" &&
    !gbpAccount.gbpLocationId &&
    gbpAccount.pendingLocations?.length > 0
  ) {
    result.needsLocationPicker = true;
    result.locations = gbpAccount.pendingLocations;
  }

  return result;
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
  connectAndSaveTokens,
  retrySync,
  selectLocation,
  disconnect,
  getStatus,
  SCOPES,
};
