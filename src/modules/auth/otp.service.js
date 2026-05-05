const crypto = require("crypto");
const bcrypt = require("bcrypt");
const env = require("../../config/env");
const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const EmailOtp = require("./emailOtp.model");

const CODE_LENGTH = 6;

const generateCode = () => {
  const max = 10 ** CODE_LENGTH;
  const n = crypto.randomInt(0, max);
  return n.toString().padStart(CODE_LENGTH, "0");
};

const issueOtp = async ({ userId, email, purpose, meta = null }) => {
  await EmailOtp.updateMany(
    { userId, purpose, consumedAt: null },
    { $set: { consumedAt: new Date() } }
  );

  const code = generateCode();
  const codeHash = await bcrypt.hash(code, env.bcryptSaltRounds);
  const expiresAt = new Date(Date.now() + env.otpTtlMinutes * 60 * 1000);

  await EmailOtp.create({ userId, email, codeHash, purpose, expiresAt, meta });

  return { code, expiresAt };
};

const verifyOtp = async ({ userId, purpose, code }) => {
  const otp = await EmailOtp.findOne({ userId, purpose, consumedAt: null }).sort({ createdAt: -1 });

  if (!otp) {
    throw new ApiError(400, "No active verification code.", { code: ERROR_CODES.OTP_INVALID });
  }

  if (otp.expiresAt.getTime() < Date.now()) {
    throw new ApiError(400, "Verification code has expired.", { code: ERROR_CODES.OTP_EXPIRED });
  }

  if (otp.attempts >= env.otpMaxAttempts) {
    throw new ApiError(429, "Too many attempts. Request a new code.", {
      code: ERROR_CODES.OTP_TOO_MANY_ATTEMPTS,
    });
  }

  const isValid = await bcrypt.compare(String(code || ""), otp.codeHash);

  if (!isValid) {
    otp.attempts += 1;
    await otp.save();
    throw new ApiError(400, "Invalid verification code.", { code: ERROR_CODES.OTP_INVALID });
  }

  otp.consumedAt = new Date();
  await otp.save();

  return { meta: otp.meta };
};

module.exports = { issueOtp, verifyOtp };
