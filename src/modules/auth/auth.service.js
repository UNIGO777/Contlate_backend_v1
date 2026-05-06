const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const env = require("../../config/env");
const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const { OTP_PURPOSES } = require("../../constants/otpPurposes");
const User = require("../user/user.model");
const EmailOtp = require("./emailOtp.model");
const otpService = require("./otp.service");
const mailService = require("../../services/mail.service");

const sanitizeUser = (user) => ({
  id: user._id.toString(),
  name: user.name,
  email: user.email,
  phone: user.phone || null,
  avatarUrl: user.avatarUrl || null,
  role: user.role,
  plan: user.plan,
  isEmailVerified: user.isEmailVerified,
  trialStartAt: user.trialStartAt,
  trialEndsAt: user.trialEndsAt,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const buildAccessPayload = (user) => ({
  id: user._id.toString(),
  role: user.role,
  plan: user.plan,
  email: user.email,
});

const signAccessToken = (user) =>
  jwt.sign(buildAccessPayload(user), env.jwtSecret, { expiresIn: env.jwtExpiresIn });

const parseDurationMs = (expiresIn) => {
  const match = /^(\d+)([smhdw])$/.exec(String(expiresIn));
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const n = Number(match[1]);
  const unit = match[2];
  const map = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return n * map[unit];
};

const hashToken = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

const issueRefreshToken = async (user, device) => {
  const raw = crypto.randomBytes(48).toString("hex");
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + parseDurationMs(env.jwtRefreshExpiresIn));

  user.refreshTokens.push({ tokenHash, device: device || null, expiresAt });
  // Cap stored tokens per user to avoid unbounded growth.
  if (user.refreshTokens.length > 10) {
    user.refreshTokens = user.refreshTokens.slice(-10);
  }
  await user.save();

  const token = jwt.sign({ id: user._id.toString(), jti: tokenHash }, env.jwtRefreshSecret, {
    expiresIn: env.jwtRefreshExpiresIn,
  });

  return { token, raw, expiresAt };
};

const revokeRefreshToken = async (user, rawOrJti) => {
  const jti = rawOrJti.length === 64 ? rawOrJti : hashToken(rawOrJti);
  const entry = user.refreshTokens.find((t) => t.tokenHash === jti && !t.revokedAt);
  if (entry) {
    entry.revokedAt = new Date();
    await user.save();
  }
};

const buildSession = async (user, device) => {
  const refresh = await issueRefreshToken(user, device);
  return {
    user: sanitizeUser(user),
    accessToken: signAccessToken(user),
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
  };
};

const registerUser = async ({ name, email, password }) => {
  // Reject if a verified account already exists.
  const existing = await User.findOne({ email });
  if (existing) {
    throw new ApiError(409, "A user with this email already exists.", {
      code: ERROR_CODES.AUTH_EMAIL_EXISTS,
    });
  }

  const passwordHash = await bcrypt.hash(password, env.bcryptSaltRounds);

  // Use a pre-generated ObjectId as a placeholder — the real User document
  // is only created inside verifyEmail once the OTP is confirmed.
  const pendingId = new mongoose.Types.ObjectId();

  const { code } = await otpService.issueOtp({
    userId: pendingId,
    email,
    purpose: OTP_PURPOSES.VERIFY_EMAIL,
    meta: { name, passwordHash },
  });

  await mailService.send({
    to: email,
    subject: "Verify your email",
    template: "verify_email",
    data: { name, code },
  });

  return { email };
};

const loginUser = async ({ email, password }, { device } = {}) => {
  const user = await User.findOne({ email });

  if (!user || user.deletedAt) {
    throw new ApiError(401, "Invalid email or password.", {
      code: ERROR_CODES.AUTH_INVALID_CREDENTIALS,
    });
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw new ApiError(423, "Account temporarily locked. Try again later.", {
      code: ERROR_CODES.AUTH_ACCOUNT_LOCKED,
      details: { lockedUntil: user.lockedUntil },
    });
  }

  if (!user.isEmailVerified) {
    throw new ApiError(403, "Please verify your email before signing in.", {
      code: ERROR_CODES.AUTH_EMAIL_NOT_VERIFIED,
    });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    user.loginFailures += 1;
    if (user.loginFailures >= env.loginMaxAttempts) {
      user.lockedUntil = new Date(Date.now() + env.loginLockoutMinutes * 60 * 1000);
      user.loginFailures = 0;
    }
    await user.save();
    throw new ApiError(401, "Invalid email or password.", {
      code: ERROR_CODES.AUTH_INVALID_CREDENTIALS,
    });
  }

  user.loginFailures = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date();
  await user.save();

  return buildSession(user, device);
};

const getCurrentUser = async (userId) => {
  const user = await User.findById(userId);
  if (!user || user.deletedAt) {
    throw new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND });
  }
  return sanitizeUser(user);
};

const sendOtp = async ({ email, purpose }) => {
  const templateByPurpose = {
    [OTP_PURPOSES.VERIFY_EMAIL]: "verify_email",
    [OTP_PURPOSES.RESET_PASSWORD]: "password_reset",
    [OTP_PURPOSES.CHANGE_EMAIL]: "verify_email",
  };

  const user = await User.findOne({ email });

  if (!user || user.deletedAt) {
    // For VERIFY_EMAIL resends, the User document may not exist yet (pending
    // registration). Look for an active OTP and re-issue under the same
    // pending userId so verifyEmail can still complete the registration.
    if (purpose === OTP_PURPOSES.VERIFY_EMAIL) {
      const pendingOtp = await EmailOtp.findOne({ email, purpose, consumedAt: null }).sort({ createdAt: -1 });
      if (pendingOtp) {
        const { code } = await otpService.issueOtp({
          userId: pendingOtp.userId,
          email,
          purpose,
          meta: pendingOtp.meta,
        });
        await mailService.send({
          to: email,
          subject: "Your verification code",
          template: "verify_email",
          data: { name: pendingOtp.meta?.name ?? "there", code },
        });
      }
    }
    // Do not leak whether the email exists.
    return { sent: true };
  }

  const { code } = await otpService.issueOtp({
    userId: user._id,
    email: user.email,
    purpose,
  });

  await mailService.send({
    to: user.email,
    subject: "Your verification code",
    template: templateByPurpose[purpose] || "verify_email",
    data: { name: user.name, code },
  });

  return { sent: true };
};

const verifyEmail = async ({ email, code, device }) => {
  // Find the pending OTP by email so we can get the placeholder userId and
  // the registration meta (name, passwordHash) stored at registration time.
  const pendingOtp = await EmailOtp.findOne({
    email,
    purpose: OTP_PURPOSES.VERIFY_EMAIL,
    consumedAt: null,
  }).sort({ createdAt: -1 });

  if (!pendingOtp) {
    throw new ApiError(400, "Invalid or expired verification code.", {
      code: ERROR_CODES.OTP_INVALID,
    });
  }

  // Validate the code (this also marks the OTP as consumed).
  await otpService.verifyOtp({
    userId: pendingOtp.userId,
    purpose: OTP_PURPOSES.VERIFY_EMAIL,
    code,
  });

  // Guard against a race condition where two requests slip through.
  const existing = await User.findOne({ email });
  if (existing) {
    return buildSession(existing, device);
  }

  // Create the User document now — only after OTP is confirmed.
  const { name, passwordHash } = pendingOtp.meta;
  const user = await User.create({
    _id: pendingOtp.userId,
    name,
    email,
    passwordHash,
    isEmailVerified: true,
  });

  return buildSession(user, device);
};

const forgotPassword = async ({ email }) => {
  return sendOtp({ email, purpose: OTP_PURPOSES.RESET_PASSWORD });
};

// Step 2 of forgot-password: validate the OTP up-front so the user gets
// instant feedback. Consumes the OTP and returns a short-lived reset
// token (10 min) that the next step uses to set a new password.
const verifyResetCode = async ({ email, code }) => {
  const user = await User.findOne({ email });
  // Constant-time-ish: don't leak whether email exists; treat as invalid OTP.
  if (!user || user.deletedAt) {
    throw new ApiError(400, "Invalid or expired code.", { code: ERROR_CODES.OTP_INVALID });
  }

  await otpService.verifyOtp({
    userId: user._id,
    purpose: OTP_PURPOSES.RESET_PASSWORD,
    code,
  });

  const resetToken = jwt.sign(
    { id: user._id.toString(), purpose: "reset_password" },
    env.jwtSecret,
    { expiresIn: "10m" }
  );

  return { resetToken };
};

const resetPassword = async ({ email, code, resetToken, newPassword }) => {
  let user;

  if (resetToken) {
    // Two-step flow: token issued by /password/verify-code
    let payload;
    try {
      payload = jwt.verify(resetToken, env.jwtSecret);
    } catch {
      throw new ApiError(401, "Reset session expired. Request a new code.", {
        code: ERROR_CODES.AUTH_TOKEN_INVALID,
      });
    }
    if (payload.purpose !== "reset_password") {
      throw new ApiError(401, "Invalid reset token.", { code: ERROR_CODES.AUTH_TOKEN_INVALID });
    }
    user = await User.findById(payload.id);
    if (!user || user.deletedAt) {
      throw new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND });
    }
    if (email && user.email !== email) {
      throw new ApiError(400, "Email mismatch.", { code: ERROR_CODES.OTP_INVALID });
    }
  } else {
    // Legacy single-step flow: { email, code } verified inline.
    user = await User.findOne({ email });
    if (!user || user.deletedAt) {
      throw new ApiError(404, "User not found.", { code: ERROR_CODES.AUTH_USER_NOT_FOUND });
    }
    await otpService.verifyOtp({
      userId: user._id,
      purpose: OTP_PURPOSES.RESET_PASSWORD,
      code,
    });
  }

  user.passwordHash = await bcrypt.hash(newPassword, env.bcryptSaltRounds);
  user.refreshTokens = [];
  user.loginFailures = 0;
  user.lockedUntil = null;
  await user.save();

  return { reset: true };
};

const refreshSession = async ({ refreshToken, device }) => {
  let decoded;
  try {
    decoded = jwt.verify(refreshToken, env.jwtRefreshSecret);
  } catch {
    throw new ApiError(401, "Invalid or expired refresh token.", {
      code: ERROR_CODES.AUTH_REFRESH_INVALID,
    });
  }

  const user = await User.findById(decoded.id);
  if (!user || user.deletedAt) {
    throw new ApiError(401, "Invalid refresh token.", { code: ERROR_CODES.AUTH_REFRESH_INVALID });
  }

  const entry = user.refreshTokens.find((t) => t.tokenHash === decoded.jti);
  if (!entry || entry.revokedAt || entry.expiresAt.getTime() < Date.now()) {
    throw new ApiError(401, "Invalid refresh token.", { code: ERROR_CODES.AUTH_REFRESH_INVALID });
  }

  entry.revokedAt = new Date();
  await user.save();

  return buildSession(user, device);
};

const logout = async ({ userId, refreshToken }) => {
  const user = await User.findById(userId);
  if (!user) return { loggedOut: true };

  if (refreshToken) {
    try {
      const decoded = jwt.verify(refreshToken, env.jwtRefreshSecret);
      await revokeRefreshToken(user, decoded.jti);
    } catch {
      // ignore
    }
  } else {
    user.refreshTokens.forEach((t) => {
      if (!t.revokedAt) t.revokedAt = new Date();
    });
    await user.save();
  }

  return { loggedOut: true };
};

module.exports = {
  registerUser,
  loginUser,
  getCurrentUser,
  sendOtp,
  verifyEmail,
  forgotPassword,
  verifyResetCode,
  resetPassword,
  refreshSession,
  logout,
  sanitizeUser,
  signAccessToken,
};
