const { isNonEmptyString } = require("../../validators/common.validator");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const finalize = (details, value) =>
  details.length ? { error: "Validation failed.", details } : { value };

const validateUpdateProfile = (req) => {
  const { name, phone, avatarUrl } = req.body || {};
  const details = [];
  const value = {};

  if (name !== undefined) {
    if (!isNonEmptyString(name)) details.push("name must be a non-empty string.");
    else value.name = name.trim();
  }
  if (phone !== undefined) {
    if (phone !== null && typeof phone !== "string") details.push("phone must be a string.");
    else value.phone = phone === null ? null : phone.trim();
  }
  if (avatarUrl !== undefined) {
    if (avatarUrl !== null && typeof avatarUrl !== "string") details.push("avatarUrl must be a string.");
    else value.avatarUrl = avatarUrl === null ? null : avatarUrl.trim();
  }

  if (Object.keys(value).length === 0 && details.length === 0) {
    details.push("At least one field is required.");
  }

  return finalize(details, value);
};

const validateChangePassword = (req) => {
  const { currentPassword, newPassword } = req.body || {};
  const details = [];
  if (!isNonEmptyString(currentPassword)) details.push("currentPassword is required.");
  if (!isNonEmptyString(newPassword)) details.push("newPassword is required.");
  else {
    if (newPassword.length < 8) details.push("newPassword must be at least 8 characters.");
    if (!/[A-Za-z]/.test(newPassword)) details.push("newPassword must contain a letter.");
    if (!/\d/.test(newPassword)) details.push("newPassword must contain a number.");
  }
  return finalize(details, { currentPassword, newPassword });
};

const validateChangeEmail = (req) => {
  const { newEmail, password } = req.body || {};
  const details = [];
  if (!isNonEmptyString(newEmail) || !EMAIL_REGEX.test(newEmail.trim())) {
    details.push("newEmail is invalid.");
  }
  if (!isNonEmptyString(password)) details.push("password is required.");
  return finalize(details, {
    newEmail: isNonEmptyString(newEmail) ? newEmail.trim().toLowerCase() : newEmail,
    password,
  });
};

module.exports = {
  validateUpdateProfile,
  validateChangePassword,
  validateChangeEmail,
};
