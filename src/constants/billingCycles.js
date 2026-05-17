const BILLING_CYCLES = Object.freeze({
  ONE_TIME: "one_time",   // single 28-day purchase, no auto-renewal
  MONTHLY:  "monthly",    // auto-pay monthly (28-day cycles)
  YEARLY:   "yearly",     // auto-pay yearly
  CYCLE_28D: "28d",       // legacy / internal — kept for backward compat
});

module.exports = { BILLING_CYCLES };
