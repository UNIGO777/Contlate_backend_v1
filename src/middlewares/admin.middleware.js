const ApiError = require("../core/ApiError");
const { ROLES } = require("../constants/roles");

const adminMiddleware = (req, _res, next) => {
  if (!req.user) {
    return next(new ApiError(401, "Authentication is required."));
  }

  if (req.user.role !== ROLES.ADMIN) {
    return next(new ApiError(403, "Admin access is required."));
  }

  return next();
};

module.exports = adminMiddleware;
