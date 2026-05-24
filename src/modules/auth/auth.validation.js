const { isNonEmptyString } = require("../../validators/common.validator");
const { OTP_PURPOSES } = require("../../constants/otpPurposes");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (email) => String(email).trim().toLowerCase();

const validatePassword = (password, details, label = "password") => {
  if (!isNonEmptyString(password)) {
    details.push(`${label} is required.`);
    return;
  }
  if (password.length < 8) details.push(`${label} must be at least 8 characters.`);
  if (!/[A-Za-z]/.test(password)) details.push(`${label} must contain a letter.`);
  if (!/\d/.test(password)) details.push(`${label} must contain a number.`);
};

const validateEmail = (email, details, label = "email") => {
  if (!isNonEmptyString(email)) {
    details.push(`${label} is required.`);
    return;
  }
  if (!EMAIL_REGEX.test(email.trim())) details.push(`${label} is invalid.`);
};

const finalize = (details, value) =>
  details.length ? { error: "Validation failed.", details } : { value };

const validateRegisterInput = (req) => {
  const { name, email, password } = req.body || {};
  const details = [];
  if (!isNonEmptyString(name)) details.push("name is required.");
  validateEmail(email, details);
  validatePassword(password, details);
  return finalize(details, {
    name: isNonEmptyString(name) ? name.trim() : name,
    email: email ? normalizeEmail(email) : email,
    password,
  });
};

const validateLoginInput = (req) => {
  const { email, password } = req.body || {};
  const details = [];
  validateEmail(email, details);
  if (!isNonEmptyString(password)) details.push("password is required.");
  return finalize(details, { email: email ? normalizeEmail(email) : email, password });
};

const validateOtpSendInput = (req) => {
  const { email, purpose } = req.body || {};
  const details = [];
  validateEmail(email, details);
  if (!Object.values(OTP_PURPOSES).includes(purpose)) details.push("purpose is invalid.");
  return finalize(details, { email: email ? normalizeEmail(email) : email, purpose });
};

const validateOtpVerifyInput = (req) => {
  const { email, code } = req.body || {};
  const details = [];
  validateEmail(email, details);
  if (!isNonEmptyString(code)) details.push("code is required.");
  return finalize(details, { email: email ? normalizeEmail(email) : email, code: String(code).trim() });
};

const validateForgotPasswordInput = (req) => {
  const { email } = req.body || {};
  const details = [];
  validateEmail(email, details);
  return finalize(details, { email: email ? normalizeEmail(email) : email });
};

const validateVerifyResetCodeInput = (req) => {
  const { email, code } = req.body || {};
  const details = [];
  validateEmail(email, details);
  if (!isNonEmptyString(code)) details.push("code is required.");
  return finalize(details, {
    email: email ? normalizeEmail(email) : email,
    code: code ? String(code).trim() : code,
  });
};

// Two-step reset: first /password/verify-code returns a resetToken,
// then /password/reset uses that token. Legacy `code` field still
// accepted for backwards-compat — one of the two must be present.
const validateResetPasswordInput = (req) => {
  const { email, code, resetToken, newPassword } = req.body || {};
  const details = [];
  validateEmail(email, details);
  if (!isNonEmptyString(code) && !isNonEmptyString(resetToken)) {
    details.push("resetToken or code is required.");
  }
  validatePassword(newPassword, details, "newPassword");
  return finalize(details, {
    email: email ? normalizeEmail(email) : email,
    code: code ? String(code).trim() : undefined,
    resetToken: resetToken ? String(resetToken).trim() : undefined,
    newPassword,
  });
};

const validateRefreshInput = (req) => {
  const { refreshToken } = req.body || {};
  const details = [];
  if (!isNonEmptyString(refreshToken)) details.push("refreshToken is required.");
  return finalize(details, { refreshToken });
};

const validateLogoutInput = (req) => {
  const { refreshToken } = req.body || {};
  return { value: { refreshToken: isNonEmptyString(refreshToken) ? refreshToken : null } };
};

const validateSocialExchangeInput = (req) => {
  const { code, state } = req.body || {};
  const details = [];
  if (!isNonEmptyString(code)) details.push("code is required.");
  if (!isNonEmptyString(state)) details.push("state is required.");
  return finalize(details, { code: String(code).trim(), state: String(state).trim() });
};

module.exports = {
  validateRegisterInput,
  validateLoginInput,
  validateOtpSendInput,
  validateOtpVerifyInput,
  validateForgotPasswordInput,
  validateVerifyResetCodeInput,
  validateResetPasswordInput,
  validateRefreshInput,
  validateLogoutInput,
  validateSocialExchangeInput,
};
