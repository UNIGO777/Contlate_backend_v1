const { isNonEmptyString } = require("../../validators/common.validator");
const { TICKET_CATEGORIES } = require("./support.model");

const MAX_SUBJECT = 140;
const MAX_MESSAGE = 4000;

const validateCreateTicket = (req) => {
  const { subject, category, message, context } = req.body || {};
  const details = [];
  const value = {};

  if (!isNonEmptyString(subject)) {
    details.push("subject is required.");
  } else if (subject.trim().length > MAX_SUBJECT) {
    details.push(`subject must be ${MAX_SUBJECT} characters or fewer.`);
  } else {
    value.subject = subject.trim();
  }

  if (!isNonEmptyString(message)) {
    details.push("message is required.");
  } else if (message.trim().length > MAX_MESSAGE) {
    details.push(`message must be ${MAX_MESSAGE} characters or fewer.`);
  } else {
    value.message = message.trim();
  }

  if (category !== undefined) {
    if (!TICKET_CATEGORIES.includes(category)) {
      details.push(`category must be one of: ${TICKET_CATEGORIES.join(", ")}.`);
    } else {
      value.category = category;
    }
  }

  // Free-form diagnostics from the client; never trusted, only recorded.
  if (context && typeof context === "object") {
    value.context = {
      appVersion: String(context.appVersion || "").slice(0, 40),
      platform: String(context.platform || "").slice(0, 40),
    };
  }

  if (details.length > 0) return { error: "Validation failed.", details };
  return { value };
};

const validateReply = (req) => {
  const { message } = req.body || {};
  const details = [];

  if (!isNonEmptyString(message)) {
    details.push("message is required.");
  } else if (message.trim().length > MAX_MESSAGE) {
    details.push(`message must be ${MAX_MESSAGE} characters or fewer.`);
  }

  if (details.length > 0) return { error: "Validation failed.", details };
  return { value: { message: message.trim() } };
};

module.exports = { validateCreateTicket, validateReply };
