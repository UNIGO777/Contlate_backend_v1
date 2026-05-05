const { PLANS } = require("./plans");

const MB = 1024 * 1024;

const PLAN_LIMITS = Object.freeze({
  [PLANS.BASIC]: {
    uploadsPerDay:        10,
    scheduledPostsPerDay: 5,
    aiPostersPerDay:      3,
    maxSocialAccounts:    2,
    maxContentItems:      100,
    maxUploadBytes:       5 * MB,
  },
  [PLANS.PRO]: {
    uploadsPerDay:        100,
    scheduledPostsPerDay: 100,
    aiPostersPerDay:      50,
    maxSocialAccounts:    10,
    maxContentItems:      5000,
    maxUploadBytes:       15 * MB,
  },
  [PLANS.STARTER]: {
    uploadsPerDay:        30,
    scheduledPostsPerDay: 28,
    aiPostersPerDay:      28,
    maxSocialAccounts:    3,
    maxContentItems:      500,
    maxUploadBytes:       10 * MB,
  },
  [PLANS.GROWTH]: {
    uploadsPerDay:        100,
    scheduledPostsPerDay: 28,
    aiPostersPerDay:      28,
    maxSocialAccounts:    5,
    maxContentItems:      2000,
    maxUploadBytes:       15 * MB,
  },
});

const USAGE_COUNTER_TO_LIMIT_KEY = Object.freeze({
  uploadsCount:         "uploadsPerDay",
  scheduledPostsCount:  "scheduledPostsPerDay",
  aiPostersCount:       "aiPostersPerDay",
  publishedPostsCount:  null,
});

module.exports = {
  PLAN_LIMITS,
  USAGE_COUNTER_TO_LIMIT_KEY,
  MB,
};
