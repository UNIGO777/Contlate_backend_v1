const { PLANS } = require("../../constants/plans");
const { SUBSCRIPTION_STATUS } = require("../../constants/subscriptionStatus");

const ALL_PLANS = Object.values(PLANS);
const ALL_STATUSES = Object.values(SUBSCRIPTION_STATUS);

const validateEditSubscription = (req) => {
  const { plan, status, endsAt } = req.body || {};
  const details = [];

  if (plan !== undefined && !ALL_PLANS.includes(plan)) {
    details.push(`plan must be one of: ${ALL_PLANS.join(", ")}.`);
  }
  if (status !== undefined && !ALL_STATUSES.includes(status)) {
    details.push(`status must be one of: ${ALL_STATUSES.join(", ")}.`);
  }
  if (endsAt !== undefined && Number.isNaN(new Date(endsAt).getTime())) {
    details.push("endsAt must be a valid ISO date string.");
  }
  if (plan === undefined && status === undefined && endsAt === undefined) {
    details.push("Provide at least one of: plan, status, endsAt.");
  }

  if (details.length > 0) return { error: "Validation failed.", details };
  return { value: { plan, status, endsAt } };
};

const validateGrantPlan = (req) => {
  const { plan, endsAt } = req.body || {};
  const details = [];

  const paidPlans = ALL_PLANS.filter((p) => p !== PLANS.BASIC);
  if (!ALL_PLANS.includes(plan)) {
    details.push(`plan must be one of: ${ALL_PLANS.join(", ")}.`);
  }
  if (endsAt !== undefined && Number.isNaN(new Date(endsAt).getTime())) {
    details.push("endsAt must be a valid ISO date string.");
  }

  if (details.length > 0) return { error: "Validation failed.", details };
  return { value: { plan, endsAt } };
};

module.exports = { validateEditSubscription, validateGrantPlan };
