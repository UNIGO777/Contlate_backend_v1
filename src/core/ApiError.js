const { ERROR_CODES } = require("../constants/errorCodes");

class ApiError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);

    this.name = "ApiError";
    this.statusCode = statusCode;
    this.success = false;
    this.code = options.code || ApiError.defaultCodeFor(statusCode);
    this.details = options.details;

    if (options.stack) {
      this.stack = options.stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  static defaultCodeFor(statusCode) {
    if (statusCode === 400) return ERROR_CODES.VALIDATION_FAILED;
    if (statusCode === 401) return ERROR_CODES.AUTH_TOKEN_INVALID;
    if (statusCode === 403) return ERROR_CODES.FORBIDDEN;
    if (statusCode === 404) return ERROR_CODES.NOT_FOUND;
    if (statusCode === 409) return ERROR_CODES.DUPLICATE_RECORD;
    if (statusCode === 429) return ERROR_CODES.RATE_LIMITED;
    return ERROR_CODES.INTERNAL;
  }
}

module.exports = ApiError;
