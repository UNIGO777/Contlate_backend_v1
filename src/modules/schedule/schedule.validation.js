const mongoose = require("mongoose");
const { isNonEmptyString } = require("../../validators/common.validator");

const isObjectId = (value) =>
  isNonEmptyString(value) && mongoose.Types.ObjectId.isValid(value);

const isValidTimezone = (tz) => {
  if (!isNonEmptyString(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const validateCreateSchedulePayload = (req) => {
  const { contentId, socialAccountId, scheduledAt, timezone } = req.body || {};
  const details = [];

  if (!isObjectId(contentId)) details.push("contentId must be a valid id.");
  if (!isObjectId(socialAccountId)) details.push("socialAccountId must be a valid id.");

  let parsedAt = null;
  if (!isNonEmptyString(scheduledAt) && !(scheduledAt instanceof Date)) {
    details.push("scheduledAt is required.");
  } else {
    parsedAt = new Date(scheduledAt);
    if (Number.isNaN(parsedAt.getTime())) {
      details.push("scheduledAt is not a valid date.");
    } else if (parsedAt.getTime() <= Date.now()) {
      details.push("scheduledAt must be in the future.");
    }
  }

  if (timezone !== undefined && !isValidTimezone(timezone)) {
    details.push("timezone is invalid.");
  }

  if (details.length > 0) return { error: "Validation failed.", details };

  return {
    value: {
      contentId: contentId.trim(),
      socialAccountId: socialAccountId.trim(),
      scheduledAt: parsedAt,
      timezone: isNonEmptyString(timezone) ? timezone.trim() : "UTC",
    },
  };
};

const validateUpdateSchedulePayload = (req) => {
  const { scheduledAt, timezone } = req.body || {};
  const details = [];
  const value = {};

  if (scheduledAt !== undefined) {
    const parsed = new Date(scheduledAt);
    if (Number.isNaN(parsed.getTime())) {
      details.push("scheduledAt is not a valid date.");
    } else if (parsed.getTime() <= Date.now()) {
      details.push("scheduledAt must be in the future.");
    } else {
      value.scheduledAt = parsed;
    }
  }

  if (timezone !== undefined) {
    if (!isValidTimezone(timezone)) {
      details.push("timezone is invalid.");
    } else {
      value.timezone = timezone.trim();
    }
  }

  if (Object.keys(value).length === 0 && details.length === 0) {
    details.push("At least one field must be provided for update.");
  }

  if (details.length > 0) return { error: "Validation failed.", details };

  return { value };
};

module.exports = {
  validateCreateSchedulePayload,
  validateUpdateSchedulePayload,
};
