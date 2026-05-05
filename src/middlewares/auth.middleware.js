const jwt = require("jsonwebtoken");
const env = require("../config/env");
const ApiError = require("../core/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const User = require("../modules/user/user.model");

const authMiddleware = async (req, _res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(
      new ApiError(401, "Authentication token is missing.", {
        code: ERROR_CODES.AUTH_TOKEN_MISSING,
      })
    );
  }

  const token = authHeader.slice(7);

  let decoded;
  try {
    decoded = jwt.verify(token, env.jwtSecret);
  } catch (_error) {
    return next(
      new ApiError(401, "Invalid or expired authentication token.", {
        code: ERROR_CODES.AUTH_TOKEN_INVALID,
      })
    );
  }

  const user = await User.findById(decoded.id).select("role plan email suspendedAt deletedAt").lean();
  if (!user || user.deletedAt) {
    return next(
      new ApiError(401, "Account not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND })
    );
  }
  if (user.suspendedAt) {
    return next(
      new ApiError(403, "Your account has been suspended. Please contact support.", {
        code: ERROR_CODES.FORBIDDEN,
      })
    );
  }

  // Refresh role/plan from DB so stale JWT claims can't escalate privileges
  req.user = { ...decoded, role: user.role, plan: user.plan };
  return next();
};

module.exports = authMiddleware;
