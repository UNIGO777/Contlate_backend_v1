const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

const validateRequiredFields = (payload, fields) => {
  const missingFields = fields.filter((field) => !isNonEmptyString(payload[field]));

  if (missingFields.length > 0) {
    return {
      error: "Validation failed.",
      details: missingFields.map((field) => `${field} is required.`),
    };
  }

  return {
    value: payload,
  };
};

module.exports = {
  isNonEmptyString,
  validateRequiredFields,
};
