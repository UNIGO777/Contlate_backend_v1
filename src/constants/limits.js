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
  [PLANS.ADVANCED]: {
    uploadsPerDay:        1000,
    scheduledPostsPerDay: 1000,
    aiPostersPerDay:      500,
    maxSocialAccounts:    100,
    maxContentItems:      100000,
    maxUploadBytes:       50 * MB,
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
