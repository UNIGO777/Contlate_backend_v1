const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");
const { isNonEmptyString } = require("../../validators/common.validator");
const {
  isSupportedPlatform,
  normalizeSocialAccountPayload,
} = require("../../services/social.service");

const validateSocialAccountPayload = (req) => {
  const payload = normalizeSocialAccountPayload(req.body);
  const details = [];

  if (!isSupportedPlatform(payload.platform)) {
    details.push("platform must be instagram or facebook.");
  }

  if (!isNonEmptyString(payload.accountName)) {
    details.push("accountName is required.");
  }

  if (!isNonEmptyString(payload.accountId)) {
    details.push("accountId is required.");
  }

  if (!isNonEmptyString(payload.accessToken)) {
    details.push("accessToken is required.");
  }

  if (
    payload.tokenExpiresAt !== null &&
    Number.isNaN(payload.tokenExpiresAt.getTime())
  ) {
    details.push("tokenExpiresAt must be a valid date when provided.");
  }

  if (details.length > 0) {
    return {
      error: "Validation failed.",
      details,
    };
  }

  return {
    value: payload,
  };
};

const validateSocialAccountUpdatePayload = (req) => {
  const details = [];
  const value = {};
  const body = req.body || {};

  if (body.accountName !== undefined) {
    if (!isNonEmptyString(body.accountName)) {
      details.push("accountName must be a non-empty string.");
    } else {
      value.accountName = body.accountName.trim();
    }
  }

  if (body.accessToken !== undefined) {
    if (!isNonEmptyString(body.accessToken)) {
      details.push("accessToken must be a non-empty string.");
    } else {
      value.accessToken = body.accessToken.trim();
    }
  }

  if (body.refreshToken !== undefined) {
    if (typeof body.refreshToken !== "string") {
      details.push("refreshToken must be a string.");
    } else {
      value.refreshToken = body.refreshToken.trim();
    }
  }

  if (body.tokenExpiresAt !== undefined) {
    const tokenExpiresAt = body.tokenExpiresAt ? new Date(body.tokenExpiresAt) : null;

    if (tokenExpiresAt && Number.isNaN(tokenExpiresAt.getTime())) {
      details.push("tokenExpiresAt must be a valid date.");
    } else {
      value.tokenExpiresAt = tokenExpiresAt;
    }
  }

  if (body.status !== undefined) {
    if (!Object.values(SOCIAL_ACCOUNT_STATUS).includes(body.status)) {
      details.push("status is invalid.");
    } else {
      value.status = body.status;
    }
  }

  if (Object.keys(value).length === 0 && details.length === 0) {
    details.push("At least one field must be provided for update.");
  }

  if (details.length > 0) {
    return {
      error: "Validation failed.",
      details,
    };
  }

  return {
    value,
  };
};

module.exports = {
  validateSocialAccountPayload,
  validateSocialAccountUpdatePayload,
};
