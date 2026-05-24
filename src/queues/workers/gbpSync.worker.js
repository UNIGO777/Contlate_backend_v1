const { Worker } = require("bullmq");
const { getConnection } = require("../connection");
const { QUEUE_NAMES } = require("../queues");
const logger = require("../../core/logger");
const { google } = require("googleapis");
const env = require("../../config/env");
const { encrypt, decrypt } = require("../../core/tokenEncryption");
const GbpAccount = require("../../modules/seo/gbpAccount.model");

// ─── Delay Helper ────────────────────────────────────────────────────────────

/**
 * Wait N milliseconds. Used between sequential Google API calls
 * to respect rate limits (Google GBP API = 1 req/sec per user).
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Default delay between Google API calls (ms)
const API_CALL_DELAY_MS = 2000;

// ─── Google API Helpers ──────────────────────────────────────────────────────

function createOAuth2Client() {
  return new google.auth.OAuth2(
    env.google.clientId,
    env.google.clientSecret,
    env.google.redirectUri
  );
}

/**
 * Check if an error is a Google API rate limit (429 / quota exceeded).
 */
function isRateLimitError(err) {
  return (
    err.code === 429 ||
    err.status === 429 ||
    (err.message && err.message.includes("Quota exceeded"))
  );
}

/**
 * Fetch all GBP accounts for the given access token.
 * Sequential pagination with delays between pages.
 */
async function fetchAccounts(accessToken) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });

  const mybusinessaccountmanagement = google.mybusinessaccountmanagement({
    version: "v1",
    auth: oauth2Client,
  });

  const allAccounts = [];
  let pageToken;
  let pageNum = 0;

  do {
    if (pageNum > 0) await delay(API_CALL_DELAY_MS);

    const res = await mybusinessaccountmanagement.accounts.list({ pageToken });
    allAccounts.push(...(res.data.accounts || []));
    pageToken = res.data.nextPageToken;
    pageNum++;
  } while (pageToken);

  return allAccounts.map((a) => ({
    accountId: a.name,
    accountName: a.accountName || a.name,
    type: a.type,
  }));
}

/**
 * Fetch all locations for a given GBP account.
 * Sequential pagination with delays between pages.
 */
async function fetchLocations(accessToken, accountId) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });

  const mybusinessbusinessinformation = google.mybusinessbusinessinformation({
    version: "v1",
    auth: oauth2Client,
  });

  const allLocations = [];
  let pageToken;
  let pageNum = 0;

  do {
    if (pageNum > 0) await delay(API_CALL_DELAY_MS);

    const res = await mybusinessbusinessinformation.accounts.locations.list({
      parent: accountId,
      readMask: "name,title,storefrontAddress",
      pageToken,
    });
    allLocations.push(...(res.data.locations || []));
    pageToken = res.data.nextPageToken;
    pageNum++;
  } while (pageToken);

  return allLocations.map((loc) => ({
    locationId: loc.name,
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

// ─── Socket Notification ─────────────────────────────────────────────────────

function emitGbpSyncResult(businessId, payload) {
  try {
    const { getIO } = require("../../core/socket");
    const io = getIO();
    if (io) {
      io.to(`business:${businessId}`).emit("gbp:sync-complete", payload);
    }
  } catch (err) {
    logger.warn("[gbpSync.worker] socket emit failed", { error: err.message });
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const start = () => {
  const worker = new Worker(
    QUEUE_NAMES.GBP_SYNC,
    async (job) => {
      const { businessId, userId } = job.data;
      logger.info("[gbpSync.worker] starting", { businessId, jobId: job.id, attempt: job.attemptsMade + 1 });

      // ── Load saved GBP account ──
      const gbpAccount = await GbpAccount.findOne({ businessId });
      if (!gbpAccount) {
        logger.warn("[gbpSync.worker] no GBP account found, skipping", { businessId });
        return { skipped: true, reason: "no_account" };
      }

      // Already fully connected with a location — skip
      if (gbpAccount.status === "connected" && gbpAccount.gbpLocationId) {
        logger.info("[gbpSync.worker] already connected, skipping", { businessId });
        return { skipped: true, reason: "already_connected" };
      }

      // ── Decrypt access token ──
      let accessToken;
      try {
        accessToken = decrypt(gbpAccount.accessToken);
      } catch {
        gbpAccount.status = "expired";
        await gbpAccount.save();
        emitGbpSyncResult(businessId.toString(), {
          success: false,
          error: "Token decryption failed. Please reconnect.",
        });
        throw new Error("Token decryption failed — marking as expired");
      }

      // ── Refresh if expired ──
      if (gbpAccount.tokenExpiry && gbpAccount.tokenExpiry.getTime() < Date.now() + 60_000) {
        logger.info("[gbpSync.worker] token expired, refreshing", { businessId });
        const oauth2Client = createOAuth2Client();
        const refreshToken = decrypt(gbpAccount.refreshToken);
        oauth2Client.setCredentials({ refresh_token: refreshToken });

        const { credentials } = await oauth2Client.refreshAccessToken();
        if (!credentials.access_token) {
          gbpAccount.status = "expired";
          await gbpAccount.save();
          emitGbpSyncResult(businessId.toString(), {
            success: false,
            error: "Token refresh failed. Please reconnect.",
          });
          throw new Error("Token refresh failed — marking as expired");
        }

        accessToken = credentials.access_token;
        gbpAccount.accessToken = encrypt(credentials.access_token);
        gbpAccount.tokenExpiry = credentials.expiry_date
          ? new Date(credentials.expiry_date)
          : new Date(Date.now() + 3600_000);
        await gbpAccount.save();
      }

      // ── Fetch accounts (sequential with delays) ──
      let accounts;
      try {
        accounts = await fetchAccounts(accessToken);
      } catch (err) {
        if (isRateLimitError(err)) {
          logger.warn("[gbpSync.worker] rate limited on accounts fetch, will retry", {
            businessId,
            attempt: job.attemptsMade + 1,
          });
          throw err; // BullMQ will retry with exponential backoff
        }
        throw err;
      }

      if (accounts.length === 0) {
        gbpAccount.status = "connected";
        await gbpAccount.save();
        emitGbpSyncResult(businessId.toString(), {
          success: false,
          error: "No Google Business Profile found for this Google account.",
        });
        return { error: "no_accounts" };
      }

      // ── Delay before fetching locations ──
      await delay(API_CALL_DELAY_MS);

      // ── Fetch locations for each account (sequential) ──
      const allLocations = [];
      for (let i = 0; i < accounts.length; i++) {
        if (i > 0) await delay(API_CALL_DELAY_MS); // delay between accounts

        try {
          const locations = await fetchLocations(accessToken, accounts[i].accountId);
          allLocations.push(
            ...locations.map((loc) => ({
              ...loc,
              accountId: accounts[i].accountId,
              accountName: accounts[i].accountName,
            }))
          );
        } catch (err) {
          if (isRateLimitError(err)) {
            logger.warn("[gbpSync.worker] rate limited on locations fetch, will retry", {
              businessId,
              accountId: accounts[i].accountId,
              attempt: job.attemptsMade + 1,
            });
            throw err; // BullMQ will retry
          }
          throw err;
        }
      }

      if (allLocations.length === 0) {
        gbpAccount.status = "connected";
        await gbpAccount.save();
        emitGbpSyncResult(businessId.toString(), {
          success: false,
          error: "No business locations found. Please add a location on Google first.",
        });
        return { error: "no_locations" };
      }

      // ── Update DB with results ──
      const autoConnected = allLocations.length === 1;
      const locationsMapped = allLocations.map((loc) => ({
        locationId: loc.locationId,
        locationName: loc.locationName,
        address: loc.address,
        accountId: loc.accountId,
        accountName: loc.accountName,
      }));

      gbpAccount.status = "connected";
      gbpAccount.gbpAccountId = autoConnected ? allLocations[0].accountId : "";
      gbpAccount.gbpAccountName = autoConnected ? allLocations[0].accountName : "";
      gbpAccount.gbpLocationId = autoConnected ? allLocations[0].locationId : "";
      gbpAccount.gbpLocationName = autoConnected ? allLocations[0].locationName : "";
      // Store locations for picker UI (cleared after user selects)
      gbpAccount.pendingLocations = autoConnected ? [] : locationsMapped;
      await gbpAccount.save();

      logger.info("[gbpSync.worker] done", {
        businessId,
        accountCount: accounts.length,
        locationCount: allLocations.length,
        autoConnected,
      });

      // ── Notify frontend via socket ──
      emitGbpSyncResult(businessId.toString(), {
        success: true,
        autoConnected,
        locations: allLocations.map((loc) => ({
          locationId: loc.locationId,
          locationName: loc.locationName,
          address: loc.address,
          accountId: loc.accountId,
          accountName: loc.accountName,
        })),
        locationName: autoConnected ? allLocations[0].locationName : undefined,
      });

      // ── Auto-trigger AI SEO if single location ──
      if (autoConnected) {
        try {
          const aiSeoService = require("../../modules/ai-seo/aiSeo.service");
          aiSeoService.generateKeywords(userId, businessId).catch((err) => {
            logger.warn("[gbpSync.worker] auto AI SEO generation failed", { error: err.message });
          });
        } catch (err) {
          logger.warn("[gbpSync.worker] aiSeo require failed", { error: err.message });
        }
      }

      return {
        accountCount: accounts.length,
        locationCount: allLocations.length,
        autoConnected,
      };
    },
    {
      connection: getConnection(),
      concurrency: 2, // max 2 GBP syncs at a time to stay well under Google rate limits
    }
  );

  worker.on("failed", (job, err) => {
    const isLastAttempt = job && job.attemptsMade >= (job.opts?.attempts || 5);
    logger.error("[gbpSync.worker] failed", {
      jobId: job?.id,
      businessId: job?.data?.businessId,
      attempt: job?.attemptsMade,
      error: err.message,
      final: isLastAttempt,
    });

    // If final failure, notify frontend and update status
    if (isLastAttempt && job?.data?.businessId) {
      GbpAccount.updateOne(
        { businessId: job.data.businessId, status: "syncing" },
        { $set: { status: "pending_locations" } }
      ).catch(() => {});

      emitGbpSyncResult(job.data.businessId.toString(), {
        success: false,
        error: "Failed to fetch your business locations after multiple attempts. Please try again.",
        canRetry: true,
      });
    }
  });

  return worker;
};

module.exports = { start };
