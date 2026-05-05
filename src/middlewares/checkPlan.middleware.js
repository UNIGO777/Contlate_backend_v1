const ApiError = require("../core/ApiError");
const { PLAN_ORDER } = require("../constants/plans");

const checkPlanMiddleware = (minimumPlan) => {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new ApiError(401, "Authentication is required."));
    }

    const currentPlan = req.user.plan;

    if (!currentPlan || !PLAN_ORDER[currentPlan]) {
      return next(new ApiError(403, "An active plan is required."));
    }

    if (PLAN_ORDER[currentPlan] < PLAN_ORDER[minimumPlan]) {
      return next(new ApiError(403, `This feature requires the ${minimumPlan} plan.`));
    }

    return next();
  };
};

module.exports = checkPlanMiddleware;
