const PLANS = Object.freeze({
  BASIC:   "basic",
  PRO:     "pro",
  STARTER: "starter",
  GROWTH:  "growth",
});

const PLAN_ORDER = Object.freeze({
  [PLANS.BASIC]:   1,
  [PLANS.PRO]:     2,
  [PLANS.STARTER]: 2,
  [PLANS.GROWTH]:  3,
});

const PLAN_DETAILS = Object.freeze({
  [PLANS.BASIC]: {
    code:         PLANS.BASIC,
    name:         "Basic",
    price:        799,
    currency:     "INR",
    billingCycle: "monthly",
    badge:        null,
  },
  [PLANS.PRO]: {
    code:         PLANS.PRO,
    name:         "Pro",
    price:        1299,
    currency:     "INR",
    billingCycle: "monthly",
    badge:        null,
  },
  [PLANS.STARTER]: {
    code:         PLANS.STARTER,
    name:         "Starter",
    price:        1499,
    originalPrice: 3000,
    currency:     "INR",
    billingCycle: "28d",
    badge:        null,
    features: [
      "28 days of AI posts",
      "Instagram posting",
      "Facebook posting",
      "X (Twitter) posting",
      "AI-generated content",
      "Custom brand theme",
    ],
  },
  [PLANS.GROWTH]: {
    code:         PLANS.GROWTH,
    name:         "Growth",
    price:        1999,
    originalPrice: 4000,
    currency:     "INR",
    billingCycle: "28d",
    badge:        "Most Popular",
    features: [
      "Everything in Starter",
      "Google Business Profile SEO",
      "Keyword-optimised posts",
      "Monthly performance report",
      "Priority support",
    ],
  },
});

module.exports = {
  PLANS,
  PLAN_ORDER,
  PLAN_DETAILS,
};
