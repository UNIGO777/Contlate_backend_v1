const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const { OTP_PURPOSES } = require("../../constants/otpPurposes");
const authService = require("./auth.service");

const deviceFromReq = (req) => (req.headers["x-device"] ? String(req.headers["x-device"]) : null);

const register = asyncHandler(async (req, res) => {
  const result = await authService.registerUser(req.validated, { device: deviceFromReq(req) });
  return res.status(201).json(new ApiResponse(201, result, "User registered successfully."));
});

const login = asyncHandler(async (req, res) => {
  const result = await authService.loginUser(req.validated, { device: deviceFromReq(req) });
  const message = result.requiresOtp ? "Verification code sent." : "Login successful.";
  return res.status(200).json(new ApiResponse(200, result, message));
});

const me = asyncHandler(async (req, res) => {
  const user = await authService.getCurrentUser(req.user.id);
  return res.status(200).json(new ApiResponse(200, { user }, "Current user fetched successfully."));
});

const sendOtp = asyncHandler(async (req, res) => {
  const result = await authService.sendOtp(req.validated);
  return res.status(200).json(new ApiResponse(200, result, "If the account exists, a code has been sent."));
});

const verifyOtp = asyncHandler(async (req, res) => {
  // For Phase 1 we expose email verification here; reset_password verification is
  // performed as part of /auth/password/reset.
  const result = await authService.verifyEmail({
    email: req.validated.email,
    code: req.validated.code,
    device: deviceFromReq(req),
  });
  return res.status(200).json(new ApiResponse(200, result, "Email verified."));
});

const forgotPassword = asyncHandler(async (req, res) => {
  const result = await authService.forgotPassword(req.validated);
  return res.status(200).json(new ApiResponse(200, result, "If the account exists, a reset code has been sent."));
});

const verifyResetCode = asyncHandler(async (req, res) => {
  const result = await authService.verifyResetCode(req.validated);
  return res.status(200).json(new ApiResponse(200, result, "Code verified."));
});

const resetPassword = asyncHandler(async (req, res) => {
  const result = await authService.resetPassword(req.validated);
  return res.status(200).json(new ApiResponse(200, result, "Password reset successfully."));
});

const refresh = asyncHandler(async (req, res) => {
  const result = await authService.refreshSession({
    refreshToken: req.validated.refreshToken,
    device: deviceFromReq(req),
  });
  return res.status(200).json(new ApiResponse(200, result, "Session refreshed."));
});

const logout = asyncHandler(async (req, res) => {
  const result = await authService.logout({
    userId: req.user.id,
    refreshToken: req.validated.refreshToken,
  });
  return res.status(200).json(new ApiResponse(200, result, "Logged out."));
});

module.exports = {
  register,
  login,
  me,
  sendOtp,
  verifyOtp,
  forgotPassword,
  verifyResetCode,
  resetPassword,
  refresh,
  logout,
  OTP_PURPOSES,
};
