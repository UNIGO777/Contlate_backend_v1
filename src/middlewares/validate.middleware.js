const ApiError = require("../core/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");

const validateMiddleware = (validator) => {
  return (req, _res, next) => {
    const result = validator(req);

    if (!result || typeof result !== "object") {
      return next(new ApiError(500, "Validator must return a result object."));
    }

    if (result.error) {
      return next(
        new ApiError(400, result.error, {
          code: ERROR_CODES.VALIDATION_FAILED,
          details: result.details && result.details.length ? result.details : undefined,
        })
      );
    }

    if (result.value) {
      req.validated = result.value;
    }

    return next();
  };
};

module.exports = validateMiddleware;
