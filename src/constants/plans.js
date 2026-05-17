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

// Pricing per billing type
// ONE_TIME  = single 28-day purchase, no auto-renewal
// MONTHLY   = auto-pay monthly (28-day cycles)
// YEARLY    = auto-pay yearly (billed once per year)
const PLAN_PRICING = Object.freeze({
  [PLANS.PRO]: {
    one_time: 1999,
    monthly:  1499,
    yearly:   1299,
  },
  [PLANS.ADVANCED]: {
    one_time: 2999,
    monthly:  1999,
    yearly:   1799,
  },
});

const PLAN_DETAILS = Object.freeze({
  [PLANS.BASIC]: {
    code:         PLANS.BASIC,
    name:         "Free",
    price:        0,
    currency:     "INR",
    billingCycle: null,
    badge:        null,
    description:  "Try it out with 2 days of free posts",
    canEditPoster: false,
    features: [
      "2 days of posts",
      "AI-generated posters",
      "1 social account",
      "Cannot customise poster before generating",
    ],
  },
  [PLANS.PRO]: {
    code:         PLANS.PRO,
    name:         "Pro",
    price:        1999,           // default one-time price
    pricing:      PLAN_PRICING[PLANS.PRO],
    currency:     "INR",
    billingCycle: "monthly",
    badge:        null,
    description:  "Social media management for 28 days",
    canEditPoster: true,
    features: [
      "28 days social media management",
      "Daily post generated for next day",
      "Customise poster before generating",
      "All social accounts",
      "Priority support",
    ],
  },
  [PLANS.ADVANCED]: {
    code:         PLANS.ADVANCED,
    name:         "Advanced",
    price:        2999,           // default one-time price
    pricing:      PLAN_PRICING[PLANS.ADVANCED],
    currency:     "INR",
    billingCycle: "monthly",
    badge:        "Best Value",
    description:  "Social media + Google Business Profile SEO",
    canEditPoster: true,
    features: [
      "Everything in Pro",
      "Google Business Profile SEO",
      "28 days social media handling",
      "Daily post generated for next day",
      "Customise poster before generating",
      "All social accounts",
      "Dedicated support",
    ],
  },
});

/**
 * Resolve the price for a plan + billing type combination.
 * @param {string} plan      – one of PLANS values
 * @param {string} billingType – "one_time" | "monthly" | "yearly"
 * @returns {number} price in INR (paise-free, whole rupees)
 */
const getPriceForPlan = (plan, billingType = "one_time") => {
  const pricing = PLAN_PRICING[plan];
  if (!pricing) return 0; // free plan
  return pricing[billingType] || pricing.one_time;
};

module.exports = {
  PLANS,
  PLAN_ORDER,
  PLAN_DETAILS,
  PLAN_PRICING,
  getPriceForPlan,
};
