const bcrypt = require("bcrypt");
const env = require("../../config/env");
const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const { OTP_PURPOSES } = require("../../constants/otpPurposes");
const User = require("./user.model");
const Business = require("../business/business.model");
const otpService = require("../auth/otp.service");
const mailService = require("../../services/mail.service");
const authService = require("../auth/auth.service");

const sanitize = authService.sanitizeUser;

const getProfile = async (userId) => {
  const user = await User.findById(userId);
  if (!user || user.deletedAt) {
    throw new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND });
  }

  const business = await Business.findOne({ userId });

  return {
    user: sanitize(user),
    business: business
      ? {
          id: business._id.toString(),
          businessName: business.businessName,
          isCompleted: business.isCompleted,
        }
      : null,
  };
};

const updateProfile = async (userId, { name, phone, avatarUrl }) => {
  const user = await User.findById(userId);
  if (!user || user.deletedAt) {
    throw new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND });
  }

  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone;
  if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
  await user.save();

  return { user: sanitize(user) };
};

const changePassword = async (userId, { currentPassword, newPassword }) => {
  const user = await User.findById(userId);
  if (!user || user.deletedAt) {
    throw new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND });
  }

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    throw new ApiError(401, "Current password is incorrect.", {
      code: ERROR_CODES.AUTH_INVALID_CREDENTIALS,
    });
  }

  user.passwordHash = await bcrypt.hash(newPassword, env.bcryptSaltRounds);
  user.refreshTokens = [];
  await user.save();

  return { changed: true };
};

const changeEmail = async (userId, { newEmail, password }) => {
  const user = await User.findById(userId);
  if (!user || user.deletedAt) {
    throw new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    throw new ApiError(401, "Password is incorrect.", {
      code: ERROR_CODES.AUTH_INVALID_CREDENTIALS,
    });
  }

  const taken = await User.findOne({ email: newEmail });
  if (taken) {
    throw new ApiError(409, "This email is already in use.", {
      code: ERROR_CODES.AUTH_EMAIL_EXISTS,
    });
  }

  user.email = newEmail;
  user.isEmailVerified = false;
  await user.save();

  const { code } = await otpService.issueOtp({
    userId: user._id,
    email: user.email,
    purpose: OTP_PURPOSES.VERIFY_EMAIL,
  });
  await mailService.send({
    to: user.email,
    subject: "Verify your new email",
    template: "verify_email",
    data: { name: user.name, code },
  });

  return { user: sanitize(user) };
};

const deleteAccount = async (userId) => {
  const user = await User.findById(userId);
  if (!user || user.deletedAt) {
    throw new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND });
  }
  user.deletedAt = new Date();
  user.refreshTokens = [];
  await user.save();
  return { deleted: true };
};

module.exports = {
  getProfile,
  updateProfile,
  changePassword,
  changeEmail,
  deleteAccount,
};
