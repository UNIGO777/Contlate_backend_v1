const asyncHandler = require("../core/asyncHandler");
const ApiError = require("../core/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const User = require("../modules/user/user.model");

const requireVerifiedEmailMiddleware = asyncHandler(async (req, _res, next) => {
  if (!req.user) {
    return next(new ApiError(401, "Authentication is required.", { code: ERROR_CODES.AUTH_TOKEN_MISSING }));
  }
  const user = await User.findById(req.user.id).select("isEmailVerified deletedAt");
  if (!user || user.deletedAt) {
    return next(new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND }));
  }
  if (!user.isEmailVerified) {
    return next(
      new ApiError(403, "Email verification is required.", {
        code: ERROR_CODES.AUTH_EMAIL_NOT_VERIFIED,
      })
    );
  }
  return next();
});

module.exports = requireVerifiedEmailMiddleware;
