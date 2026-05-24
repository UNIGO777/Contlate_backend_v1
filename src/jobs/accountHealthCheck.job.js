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
 * Send a notification to the account owner (fire-and-forget).
 */
const notifyUser = (userId, type, data) => {
  User.findById(userId)
    .lean()
    .then((user) => {
      const opts = user ? { userEmail: user.email, userName: user.name } : {};
      sendAppNotification(userId, type, data, opts);
    })
    .catch(() => {
      sendAppNotification(userId, type, data);
    });
};

/**
 * Check token validity and permissions.
 * Returns { tokenValid, grantedScopes, declined, missing }.
 */
const checkTokenAndPermissions = async (token) => {
  // Step 1: Verify token is valid
  try {
    await metaService.graphFetch("/me", {
      searchParams: { access_token: token },
    });
  } catch (err) {
    if (err.isAuthError || err.metaCode === 190) {
      return { tokenValid: false, reason: "token_invalid" };
    }
    throw err; // transient — re-throw to skip this account
  }

  // Step 2: Check permissions
  const { granted, declined, missing } = await metaService.detectMissingScopes(token);

  const requiredMissing = metaService.PUBLISH_SCOPES.filter(
    (s) => !granted.includes(s)
  );

  return {
    tokenValid: true,
    grantedScopes: granted,
    declined,
    missing,
    permissionsMissing: requiredMissing.length > 0,
    requiredMissing,
  };
};

/**
 * Check if a Facebook page still exists and if its IG is still linked/professional.
 */
const checkPageHealth = async (account, userToken) => {
  const issues = [];

  // Only Facebook accounts have pages to check
  if (account.platform !== SOCIAL_PLATFORMS.FACEBOOK) return { issues };

  try {
    const pages = await metaService.listManagedPages(userToken);
    const myPage = pages.find((p) => p.pageId === account.accountId);

    if (!myPage) {
      return { issues: ["page_deleted"], pageDeleted: true };
    }

    // Check canPublish (page role)
    if (!myPage.canPublish) {
      issues.push("page_access_lost");
    }

    // Check Instagram linkage
    const igAccount = await SocialAccount.findOne({
      userId: account.userId,
      platform: SOCIAL_PLATFORMS.INSTAGRAM,
      pageId: account.pageId,
      status: { $ne: SOCIAL_ACCOUNT_STATUS.DISCONNECTED },
    }).lean();

    if (igAccount) {
      // IG account exists in DB — check if still linked on Meta side
      if (!myPage.instagramAccountId) {
        issues.push("ig_unlinked");
      } else {
        // Check if IG is still professional
        try {
          const detail = await metaService.getPageDetailedStatus(myPage, userToken);
          if (detail.instagram?.linked && !detail.instagram?.isProfessional) {
            issues.push("personal_instagram");
          }
        } catch {
          // Non-fatal — IG type check failed
        }
      }
    }

    return { issues, pageDeleted: false };
  } catch (err) {
    if (err.isRateLimit) {
      logger.warn("[accountHealthCheck] rate limited during page check", {
        accountId: account._id.toString(),
      });
      return { issues, skipped: true };
    }
    throw err;
  }
};

/**
 * Apply health check results to a single account.
 */
const applyHealthResults = async (account, tokenResult, pageResult) => {
  const updates = {};
  const setupIssues = [];

  // Update grantedScopes cache
  if (tokenResult.grantedScopes) {
    updates.grantedScopes = tokenResult.grantedScopes;
  }

  // Token invalid
  if (!tokenResult.tokenValid) {
    updates.status = SOCIAL_ACCOUNT_STATUS.EXPIRED;
    updates.healthStatus = "critical";
    updates.disconnectReason = "token_expired";

    await SocialAccount.findByIdAndUpdate(account._id, { $set: updates });

    notifyUser(account.userId, "SOCIAL_ACCOUNT_EXPIRED", {
      platform: account.platform,
      accountName: account.accountName,
    });
    return "token_invalid";
  }

  // Permissions missing
  if (tokenResult.permissionsMissing) {
    setupIssues.push("missing_permissions");
    updates.status = SOCIAL_ACCOUNT_STATUS.EXPIRED;
    updates.healthStatus = "critical";
    updates.disconnectReason = "permissions_revoked";

    await SocialAccount.findByIdAndUpdate(account._id, {
      $set: { ...updates, setupIssues },
    });

    notifyUser(account.userId, "PERMISSIONS_REVOKED", {
      platform: account.platform,
      accountName: account.accountName,
    });
    return "permissions_missing";
  }

  // Page-level issues
  if (pageResult?.pageDeleted) {
    updates.status = SOCIAL_ACCOUNT_STATUS.DISCONNECTED;
    updates.healthStatus = "critical";
    updates.disconnectReason = "page_deleted";

    await SocialAccount.findByIdAndUpdate(account._id, { $set: updates });

    // Also disconnect linked IG account
    await SocialAccount.updateMany(
      {
        userId: account.userId,
        platform: SOCIAL_PLATFORMS.INSTAGRAM,
        pageId: account.pageId,
        status: { $ne: SOCIAL_ACCOUNT_STATUS.DISCONNECTED },
      },
      {
        $set: {
          status: SOCIAL_ACCOUNT_STATUS.DISCONNECTED,
          healthStatus: "critical",
          disconnectReason: "page_deleted",
        },
      }
    );

    // Cancel pending schedules for this account
    const Schedule = require("../modules/schedule/schedule.model");
    const { SCHEDULE_STATUS } = require("../constants/scheduleStatus");
    await Schedule.updateMany(
      {
        socialAccountId: account._id,
        status: { $in: [SCHEDULE_STATUS.PENDING, SCHEDULE_STATUS.PAUSED] },
      },
      { $set: { status: SCHEDULE_STATUS.CANCELLED } }
    );

    notifyUser(account.userId, "ACCOUNT_DISCONNECTED", {
      platform: account.platform,
      accountName: account.accountName,
      reason: `Your Facebook Page '${account.accountName}' is no longer available.`,
    });
    return "page_deleted";
  }

  // IG unlinked from page
  if (pageResult?.issues?.includes("ig_unlinked")) {
    const igAccount = await SocialAccount.findOne({
      userId: account.userId,
      platform: SOCIAL_PLATFORMS.INSTAGRAM,
      pageId: account.pageId,
      status: { $ne: SOCIAL_ACCOUNT_STATUS.DISCONNECTED },
    });

    if (igAccount) {
      await SocialAccount.findByIdAndUpdate(igAccount._id, {
        $set: {
          status: SOCIAL_ACCOUNT_STATUS.DISCONNECTED,
          healthStatus: "critical",
          disconnectReason: "ig_unlinked",
          setupIssues: ["ig_unlinked"],
        },
      });

      // Cancel IG pending schedules
      const Schedule = require("../modules/schedule/schedule.model");
      const { SCHEDULE_STATUS } = require("../constants/scheduleStatus");
      await Schedule.updateMany(
        {
          socialAccountId: igAccount._id,
          status: { $in: [SCHEDULE_STATUS.PENDING, SCHEDULE_STATUS.PAUSED] },
        },
        { $set: { status: SCHEDULE_STATUS.CANCELLED } }
      );

      notifyUser(account.userId, "ACCOUNT_DISCONNECTED", {
        platform: "instagram",
        accountName: igAccount.accountName,
        reason: `Instagram account '${igAccount.accountName}' is no longer linked to your Facebook Page.`,
      });
    }
  }

  // Page access lost (non-publishable role)
  if (pageResult?.issues?.includes("page_access_lost")) {
    setupIssues.push("page_access_lost");
    updates.healthStatus = "warning";
  }

  // Personal instagram
  if (pageResult?.issues?.includes("personal_instagram")) {
    const igAccount = await SocialAccount.findOne({
      userId: account.userId,
      platform: SOCIAL_PLATFORMS.INSTAGRAM,
      pageId: account.pageId,
      status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
    });

    if (igAccount) {
      await SocialAccount.findByIdAndUpdate(igAccount._id, {
        $set: {
          healthStatus: "warning",
          setupIssues: ["personal_instagram"],
        },
      });
    }
  }

  // All good — mark healthy
  if (setupIssues.length === 0 && !pageResult?.issues?.length) {
    updates.healthStatus = "healthy";
    updates.setupIssues = [];
  } else {
    updates.setupIssues = setupIssues;
    if (!updates.healthStatus) updates.healthStatus = "warning";
  }

  updates.lastSyncedAt = new Date();
  await SocialAccount.findByIdAndUpdate(account._id, { $set: updates });

  return setupIssues.length > 0 ? "issues_found" : "healthy";
};

const runOnce = async () => {
  const accounts = await findAccountsToCheck();
  if (!accounts.length) return { checked: 0, unhealthy: 0 };

  let checked = 0;
  let unhealthy = 0;

  // Group Facebook accounts by userId to share token checks
  // (avoid redundant /me calls for accounts under the same user)
  const userTokenCache = new Map();

  for (const account of accounts) {
    try {
      const rawToken = account.userAccessToken || account.accessToken;
      if (!rawToken) {
        await SocialAccount.findByIdAndUpdate(account._id, {
          $set: {
            status: SOCIAL_ACCOUNT_STATUS.EXPIRED,
            healthStatus: "critical",
            disconnectReason: "token_expired",
          },
        });
        checked++;
        unhealthy++;
        continue;
      }

      const token = safeDecrypt(rawToken);
      if (!token) {
        await SocialAccount.findByIdAndUpdate(account._id, {
          $set: {
            status: SOCIAL_ACCOUNT_STATUS.EXPIRED,
            healthStatus: "critical",
            disconnectReason: "token_expired",
          },
        });
        checked++;
        unhealthy++;
        continue;
      }

      // Check token + permissions (cached per user to avoid duplicate API calls)
      const cacheKey = account.userId.toString();
      let tokenResult = userTokenCache.get(cacheKey);
      if (!tokenResult) {
        tokenResult = await checkTokenAndPermissions(token);
        userTokenCache.set(cacheKey, tokenResult);
      }

      // Check page-level health (only for FB accounts)
      let pageResult = null;
      if (account.platform === SOCIAL_PLATFORMS.FACEBOOK && tokenResult.tokenValid) {
        pageResult = await checkPageHealth(account, token);
      }

      const result = await applyHealthResults(account, tokenResult, pageResult);
      checked++;
      if (result !== "healthy") unhealthy++;

      logger.info("[accountHealthCheck] checked", {
        accountId: account._id.toString(),
        platform: account.platform,
        result,
      });
    } catch (err) {
      // Transient error (network, etc.) — skip, don't mark unhealthy
      logger.warn("[accountHealthCheck] check failed (transient)", {
        accountId: account._id.toString(),
        message: err.message,
      });
    }
  }

  // Clean up stale pending_setup placeholders (older than 7 days)
  // The TTL index handles this automatically, but this is a safety net
  try {
    const deleted = await SocialAccount.deleteMany({
      status: SOCIAL_ACCOUNT_STATUS.PENDING_SETUP,
      createdAt: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    });
    if (deleted.deletedCount > 0) {
      logger.info("[accountHealthCheck] cleaned up stale pending_setup accounts", {
        count: deleted.deletedCount,
      });
    }
  } catch {
    // Non-fatal
  }

  if (checked) {
    await JobLog.create({
      type: JOB_TYPE,
      status: unhealthy > 0 ? "failed" : "success",
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
