const PLANS = Object.freeze({
  BASIC:    "basic",
  PRO:      "pro",
  ADVANCED: "advanced",
});

const PLAN_ORDER = Object.freeze({
  [PLANS.BASIC]:    1,
  [PLANS.PRO]:      2,
  [PLANS.ADVANCED]: 3,
});

const PLAN_DETAILS = Object.freeze({
  [PLANS.BASIC]: {
    code:         PLANS.BASIC,
    name:         "Free",
    price:        0,
    currency:     "INR",
    billingCycle: null,
    badge:        null,
    features: [
      "5 scheduled posts/day",
      "3 AI posts/day",
      "2 social accounts",
      "100 content items",
    ],
  },
  [PLANS.PRO]: {
    code:         PLANS.PRO,
    name:         "Pro",
    price:        1299,
    currency:     "INR",
    billingCycle: "monthly",
    badge:        null,
    features: [
      "100 scheduled posts/day",
      "50 AI posts/day",
      "10 social accounts",
      "5,000 content items",
      "15 MB upload limit",
      "Priority support",
    ],
  },
  [PLANS.ADVANCED]: {
    code:         PLANS.ADVANCED,
    name:         "Advanced",
    price:        1999,
    currency:     "INR",
    billingCycle: "monthly",
    badge:        "Most Popular",
    features: [
      "Unlimited scheduled posts",
      "Unlimited AI posts",
      "Unlimited social accounts",
      "Unlimited content items",
      "50 MB upload limit",
      "Google Business Profile SEO",
      "Monthly performance report",
      "Dedicated support",
    ],
  },
});

module.exports = {
  PLANS,
  PLAN_ORDER,
  PLAN_DETAILS,
};
