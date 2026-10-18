const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const { PLAN_LIMITS } = require("../../constants/limits");
const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");
const SocialAccount = require("./social.model");
const env = require("../../config/env");

/**
 * Every plan allows one account per network — one Instagram, one Facebook
 * Page. Reconnecting the SAME account must always be allowed, otherwise a
 * user whose token expired could never recover, so the check looks for a
 * DIFFERENT account on that platform rather than counting rows.
 *
 * @param {string} userId
 * @param {string} plan      — basic | pro | advanced
 * @param {string} platform  — instagram | facebook
 * @param {string} accountId — the platform's own id for the account being added
 */
const assertCanConnect = async (userId, plan, platform, accountId) => {
  if (env.relaxPlanLimits) return;

  const cap = PLAN_LIMITS[plan]?.maxAccountsPerPlatform ?? 1;
  if (!Number.isFinite(cap)) return;

  const existing = await SocialAccount.countDocuments({
    userId,
    platform,
    accountId: { $ne: accountId },
    status: { $ne: SOCIAL_ACCOUNT_STATUS.DISCONNECTED },
  });

  if (existing >= cap) {
    throw new ApiError(
      403,
      cap === 1
        ? `You already have a ${platform} account connected. Disconnect it first to add a different one.`
        : `Your plan allows ${cap} ${platform} accounts.`,
      { code: ERROR_CODES.PLAN_LIMIT_REACHED, details: { platform, cap } }
    );
  }
};

module.exports = { assertCanConnect };
