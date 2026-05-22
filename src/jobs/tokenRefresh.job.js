const logger = require("../core/logger");
const { SOCIAL_PLATFORMS } = require("../constants/socialPlatforms");
const { SOCIAL_ACCOUNT_STATUS } = require("../constants/socialAccountStatus");
const SocialAccount = require("../modules/social/social.model");
const User = require("../modules/user/user.model");
const metaService = require("../services/meta.service");
const { encrypt, decrypt } = require("../core/tokenEncryption");
const { sendAppNotification } = require("../utils/notifications");
const JobLog = require("./jobLog.model");

const JOB_TYPE = "tokenRefresh";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const REFRESH_DAYS_BEFORE_EXPIRY = 7; // refresh a week before token expires
const BATCH_SIZE = 50;

/**
 * Decrypt a token that may be encrypted or plaintext (backward-compat).
 */
const safeDecrypt = (token) => {
  if (!token) return "";
  try {
    return decrypt(token);
  } catch {
    return token; // already plaintext (old record)
  }
};

/**
 * Find Meta accounts whose tokens expire within REFRESH_DAYS_BEFORE_EXPIRY.
 */
const findExpiringAccounts = async (now) => {
  const cutoff = new Date(now.getTime() + REFRESH_DAYS_BEFORE_EXPIRY * 24 * 60 * 60 * 1000);

  return SocialAccount.find({
    platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
    status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
    $or: [
      // Token expires within the window
      { tokenExpiresAt: { $lte: cutoff } },
      // Token has no expiry recorded (old records) — refresh them too
      { tokenExpiresAt: null },
    ],
  })
    .limit(BATCH_SIZE)
    .lean();
};

/**
 * Refresh a Meta user-level long-lived token.
 * Meta allows refreshing a long-lived token by passing it as fb_exchange_token again.
 */
const refreshMetaToken = async (account) => {
  // Prefer userAccessToken for refresh; fall back to page accessToken
  const rawToken = account.userAccessToken || account.accessToken;
  if (!rawToken) throw new Error("No token available to refresh.");

  const currentToken = safeDecrypt(rawToken);
  if (!currentToken) throw new Error("Token decryption returned empty string.");

  const refreshed = await metaService.exchangeForLongLivedToken(currentToken);

  const tokenExpiresAt = refreshed.expiresIn
    ? new Date(Date.now() + refreshed.expiresIn * 1000)
    : null;

  const encryptedNewToken = encrypt(refreshed.accessToken);

  // For Facebook accounts: also refresh page tokens (re-fetch pages with new user token)
  let updates = {
    userAccessToken: encryptedNewToken,
    tokenExpiresAt,
    lastTokenRefreshedAt: new Date(),
    healthStatus: "healthy",
  };

  if (account.platform === SOCIAL_PLATFORMS.FACEBOOK && account.pageId) {
    // Re-fetch the page token using the new user token
    try {
      const pages = await metaService.listManagedPages(refreshed.accessToken);
      const matchedPage = pages.find((p) => p.pageId === account.accountId);
      if (matchedPage) {
        updates.accessToken = encrypt(matchedPage.pageAccessToken);
      }
    } catch (e) {
      logger.warn("[tokenRefresh] could not re-fetch page token", {
        accountId: account._id.toString(),
        message: e.message,
      });
      // Still save the refreshed userAccessToken even if page re-fetch failed
    }
  }

  await SocialAccount.findByIdAndUpdate(account._id, { $set: updates });

  // Also refresh the paired Instagram account that shares the same pageId
  if (account.platform === SOCIAL_PLATFORMS.FACEBOOK && account.pageId) {
    await SocialAccount.updateMany(
      {
        pageId: account.pageId,
        platform: SOCIAL_PLATFORMS.INSTAGRAM,
        userId: account.userId,
        status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
      },
      {
        $set: {
          userAccessToken: encryptedNewToken,
          tokenExpiresAt,
          lastTokenRefreshedAt: new Date(),
          healthStatus: "healthy",
          // Instagram uses the same page access token as the parent FB account
          ...(updates.accessToken ? { accessToken: updates.accessToken } : {}),
        },
      }
    );
  }

  return { tokenExpiresAt };
};

const runOnce = async () => {
  const now = new Date();
  const accounts = await findExpiringAccounts(now);

  if (!accounts.length) return { refreshed: 0, failed: 0 };

  let refreshed = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      const { tokenExpiresAt } = await refreshMetaToken(account);
      refreshed++;
      logger.info("[tokenRefresh] refreshed", {
        accountId: account._id.toString(),
        platform: account.platform,
        tokenExpiresAt,
      });
    } catch (err) {
      failed++;
      logger.error("[tokenRefresh] refresh failed", {
        accountId: account._id.toString(),
        platform: account.platform,
        message: err.message,
      });

      // Mark as expired if refresh itself fails (token likely revoked)
      const isAuthError = /invalid|expired|revoked|token|190|102/i.test(err.message);
      if (isAuthError) {
        await SocialAccount.findByIdAndUpdate(account._id, {
          $set: {
            status: SOCIAL_ACCOUNT_STATUS.EXPIRED,
            healthStatus: "critical",
            disconnectReason: "token_expired",
          },
        }).catch(() => {});

        const notifData = { platform: account.platform, accountName: account.accountName };
        User.findById(account.userId).lean().then((user) => {
          const opts = user ? { userEmail: user.email, userName: user.name } : {};
          sendAppNotification(account.userId, "SOCIAL_ACCOUNT_EXPIRED", notifData, opts);
        }).catch(() => {
          sendAppNotification(account.userId, "SOCIAL_ACCOUNT_EXPIRED", notifData);
        });
      }
    }
  }

  if (refreshed || failed) {
    await JobLog.create({
      type: JOB_TYPE,
      status: failed && !refreshed ? "failed" : "success",
      attempts: refreshed + failed,
      lastRunAt: now,
      errorMessage: failed ? `${failed} refresh(es) failed` : "",
    }).catch(() => {});

    logger.info("[tokenRefresh] batch done", { refreshed, failed });
  }

  return { refreshed, failed };
};

let timer = null;

const start = (intervalMs = DEFAULT_INTERVAL_MS) => {
  if (timer) return timer;

  const tick = async () => {
    try {
      await runOnce();
    } catch (err) {
      logger.error("[tokenRefresh] tick failed", {
        message: err.message,
        stack: err.stack,
      });
    }
  };

  // Run first tick after 2 minutes (let server fully start)
  setTimeout(tick, 2 * 60 * 1000);
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  logger.info("[tokenRefresh] started", { intervalMs });
  return timer;
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = { start, stop, runOnce };
