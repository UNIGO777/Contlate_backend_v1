const asyncHandler = require("../core/asyncHandler");
const usageService = require("../modules/usage/usage.service");

const usageLimitMiddleware = (counterKey) =>
  asyncHandler(async (req, _res, next) => {
    if (!req.user) return next();
    const result = await usageService.assertUsageWithinLimit(req.user.id, counterKey);
    req.usage = { ...(req.usage || {}), [counterKey]: result };
    return next();
  });

module.exports = usageLimitMiddleware;
