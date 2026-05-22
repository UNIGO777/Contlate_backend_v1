const logger = require("../core/logger");
const { SOCIAL_PLATFORMS } = require("../constants/socialPlatforms");
const { SOCIAL_ACCOUNT_STATUS } = require("../constants/socialAccountStatus");
const SocialAccount = require("../modules/social/social.model");
const User = require("../modules/user/user.model");
const metaService = require("../services/meta.service");
const { decrypt } = require("../core/tokenEncryption");
const { sendAppNotification } = require("../utils/notifications");
const JobLog = require("./jobLog.model");

const JOB_TYPE = "accountHealthCheck";
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // every 24 hours
const BATCH_SIZE = 50;

/**
 * Decrypt a token that may be encrypted or plaintext (backward-compat).
 */
const safeDecrypt = (token) => {
  if (!token) return "";
  try {
    return decrypt(token);
  } catch {
    return token;
  }
};

/**
 * Find connected Meta accounts that haven't been checked in 7+ days.
 * Acts as a safety net in case Meta fails to deliver a webhook for
 * revoked permissions or deauthorized accounts.
 */
const findAccountsToCheck = async () => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  return SocialAccount.find({
    platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
    status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
    // Only check accounts that haven't been refreshed recently
    $or: [
      { lastTokenRefreshedAt: { $lte: sevenDaysAgo } },
      { lastTokenRefreshedAt: null },
    ],
  })
    .limit(BATCH_SIZE)
    .lean();
};

/**
 * Verify an account's token is still valid by calling GET /me/permissions.
 * Returns { healthy: true } or { healthy: false, reason: "..." }.
 */
const checkAccountHealth = async (account) => {
  const rawToken = account.userAccessToken || account.accessToken;
  if (!rawToken) return { healthy: false, reason: "no_token" };

  const token = safeDecrypt(rawToken);
  if (!token) return { healthy: false, reason: "empty_token" };

  try {
    const data = await metaService.graphFetch("/me/permissions", {
      searchParams: { access_token: token },
    });

    // Check if any required permission is declined
    const permissions = data.data || [];
    const requiredScopes = [
      "pages_show_list",
      "pages_manage_posts",
      "pages_read_engagement",
    ];

    const declined = requiredScopes.filter((scope) => {
      const perm = permissions.find((p) => p.permission === scope);
      return !perm || perm.status !== "granted";
    });

    if (declined.length) {
      return { healthy: false, reason: "permissions_missing", declined };
    }

    return { healthy: true };
  } catch (err) {
    // Token is invalid or revoked
    const isAuthError = /invalid|expired|revoked|token|190|102/i.test(err.message);
    if (isAuthError) {
      return { healthy: false, reason: "token_invalid" };
    }
    // Network/transient error — don't mark unhealthy
    throw err;
  }
};

const runOnce = async () => {
  const accounts = await findAccountsToCheck();
  if (!accounts.length) return { checked: 0, unhealthy: 0 };

  let checked = 0;
  let unhealthy = 0;

  for (const account of accounts) {
    try {
      const result = await checkAccountHealth(account);
      checked++;

      if (!result.healthy) {
        unhealthy++;

        const newStatus =
          result.reason === "permissions_missing"
            ? SOCIAL_ACCOUNT_STATUS.EXPIRED
            : SOCIAL_ACCOUNT_STATUS.EXPIRED;

        const disconnectReason =
          result.reason === "permissions_missing"
            ? "permissions_revoked"
            : "token_expired";

        await SocialAccount.findByIdAndUpdate(account._id, {
          $set: {
            status: newStatus,
            healthStatus: "critical",
            disconnectReason,
          },
        });

        // Notify user
        const notifType =
          result.reason === "permissions_missing"
            ? "PERMISSIONS_REVOKED"
            : "SOCIAL_ACCOUNT_EXPIRED";

        const notifData = {
          platform: account.platform,
          accountName: account.accountName,
        };

        User.findById(account.userId)
          .lean()
          .then((user) => {
            const opts = user
              ? { userEmail: user.email, userName: user.name }
              : {};
            sendAppNotification(account.userId, notifType, notifData, opts);
          })
          .catch(() => {
            sendAppNotification(account.userId, notifType, notifData);
          });

        logger.warn("[accountHealthCheck] account unhealthy", {
          accountId: account._id.toString(),
          platform: account.platform,
          reason: result.reason,
          declined: result.declined,
        });
      } else {
        // Mark as healthy
        await SocialAccount.findByIdAndUpdate(account._id, {
          $set: { healthStatus: "healthy" },
        });
      }
    } catch (err) {
      // Transient error (network, etc.) — skip, don't mark unhealthy
      logger.warn("[accountHealthCheck] check failed (transient)", {
        accountId: account._id.toString(),
        message: err.message,
      });
    }
  }

  if (checked) {
    await JobLog.create({
      type: JOB_TYPE,
      status: unhealthy && !checked ? "failed" : "success",
      attempts: checked,
      lastRunAt: new Date(),
      errorMessage: unhealthy ? `${unhealthy} unhealthy account(s) found` : "",
    }).catch(() => {});

    logger.info("[accountHealthCheck] batch done", { checked, unhealthy });
  }

  return { checked, unhealthy };
};

let timer = null;

const start = (intervalMs = DEFAULT_INTERVAL_MS) => {
  if (timer) return timer;

  const tick = async () => {
    try {
      await runOnce();
    } catch (err) {
      logger.error("[accountHealthCheck] tick failed", {
        message: err.message,
        stack: err.stack,
      });
    }
  };

  // Run first tick after 5 minutes (let server fully start + token refresh run first)
  setTimeout(tick, 5 * 60 * 1000);
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  logger.info("[accountHealthCheck] started", { intervalMs });
  return timer;
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = { start, stop, runOnce };
