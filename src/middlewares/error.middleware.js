const ApiError = require("../core/ApiError");
const env = require("../config/env");
const logger = require("../core/logger");
const { ERROR_CODES } = require("../constants/errorCodes");

const errorMiddleware = (error, req, res, _next) => {
  let normalized;

  if (error instanceof ApiError) {
    normalized = error;
  } else if (error && error.code === 11000) {
    normalized = new ApiError(409, "A record with this value already exists.", {
      code: ERROR_CODES.DUPLICATE_RECORD,
      details: error.keyValue ? { keys: Object.keys(error.keyValue) } : undefined,
    });
  } else if (error && error.name === "ValidationError" && error.errors) {
    normalized = new ApiError(400, "Validation failed.", {
      code: ERROR_CODES.VALIDATION_FAILED,
      details: Object.fromEntries(
        Object.entries(error.errors).map(([k, v]) => [k, v.message])
      ),
    });
  } else if (error && error.name === "CastError") {
    normalized = new ApiError(400, "Invalid identifier.", {
      code: ERROR_CODES.VALIDATION_FAILED,
      details: { path: error.path, value: error.value },
    });
  } else {
    normalized = new ApiError(error.statusCode || 500, error.message || "Internal server error");
  }

  if (normalized.statusCode >= 500) {
    logger.error(normalized.message, {
      stack: normalized.stack,
      path: req.originalUrl,
      method: req.method,
    });
  }

  const body = {
    success: false,
    statusCode: normalized.statusCode,
    message: normalized.message,
    code: normalized.code,
  };

  if (normalized.details !== undefined) body.details = normalized.details;
  if (env.nodeEnv !== "production" && normalized.statusCode >= 500) {
    body.stack = normalized.stack;
  }

  return res.status(normalized.statusCode).json(body);
};

module.exports = errorMiddleware;
