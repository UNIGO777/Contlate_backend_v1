const ApiError = require("../core/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const { findBusinessDocumentByUserId } = require("../modules/business/business.service");

const REQUIRED = ["businessName", "category", "phone", "address", "timezone"];
const isComplete = (b) =>
  REQUIRED.every((f) => typeof b[f] === "string" && b[f].trim().length > 0);

const checkBusinessMiddleware = async (req, _res, next) => {
  if (!req.user) {
    return next(
      new ApiError(401, "Authentication is required.", { code: ERROR_CODES.AUTH_TOKEN_MISSING })
    );
  }

  let business = req.business;
  if (!business) {
    business = await findBusinessDocumentByUserId(req.user.id);
  }

  if (!business) {
    return next(
      new ApiError(400, "Business profile is required.", {
        code: ERROR_CODES.BUSINESS_NOT_FOUND,
      })
    );
  }

  if (!isComplete(business)) {
    return next(
      new ApiError(400, "A completed business profile is required.", {
        code: ERROR_CODES.BUSINESS_INCOMPLETE,
      })
    );
  }

  req.business = business;
  return next();
};

module.exports = checkBusinessMiddleware;
