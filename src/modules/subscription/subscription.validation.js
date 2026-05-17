const { PLANS } = require("../../constants/plans");
const { BILLING_CYCLES } = require("../../constants/billingCycles");

const ALL_BILLING_CYCLES = Object.values(BILLING_CYCLES);
const VALID_BILLING_TYPES = ["one_time", "monthly", "yearly"];

const validatePlanChangeInput = (req) => {
  const { plan, billingCycle } = req.body || {};
  const details = [];

  if (!Object.values(PLANS).includes(plan)) {
    details.push(`plan is invalid. Valid values: ${Object.values(PLANS).join(", ")}.`);
  }

  if (billingCycle !== undefined && !ALL_BILLING_CYCLES.includes(billingCycle)) {
    details.push(`billingCycle is invalid. Valid values: ${ALL_BILLING_CYCLES.join(", ")}.`);
  }

  if (details.length > 0) return { error: "Validation failed.", details };

  return {
    value: {
      plan,
      billingCycle: billingCycle || BILLING_CYCLES.MONTHLY,
    },
  };
};

const validateCheckoutInput = (req) => {
  const { plan, billingType } = req.body || {};
  const details = [];

  const paidPlans = [PLANS.PRO, PLANS.ADVANCED];
  if (!paidPlans.includes(plan)) {
    details.push(`plan must be one of: ${paidPlans.join(", ")}.`);
  }

  if (billingType !== undefined && !VALID_BILLING_TYPES.includes(billingType)) {
    details.push(`billingType must be one of: ${VALID_BILLING_TYPES.join(", ")}.`);
  }

  if (details.length > 0) return { error: "Validation failed.", details };

  return { value: { plan, billingType: billingType || "one_time" } };
};

module.exports = {
  validatePlanChangeInput,
  validateCheckoutInput,
};
