const express = require("express");
const authMiddleware = require("../../middlewares/auth.middleware");
const validateMiddleware = require("../../middlewares/validate.middleware");
const {
  authRateLimiter,
  otpRateLimiter,
} = require("../../middlewares/rateLimit.middleware");
const authController = require("./auth.controller");
const {
  validateRegisterInput,
  validateLoginInput,
  validateOtpSendInput,
  validateOtpVerifyInput,
  validateForgotPasswordInput,
  validateResetPasswordInput,
  validateRefreshInput,
  validateLogoutInput,
} = require("./auth.validation");

const router = express.Router();

router.post(
  "/register",
  authRateLimiter,
  validateMiddleware(validateRegisterInput),
  authController.register
);
router.post(
  "/login",
  authRateLimiter,
  validateMiddleware(validateLoginInput),
  authController.login
);
router.get("/me", authMiddleware, authController.me);

router.post(
  "/otp/send",
  otpRateLimiter,
  validateMiddleware(validateOtpSendInput),
  authController.sendOtp
);
router.post(
  "/otp/verify",
  authRateLimiter,
  validateMiddleware(validateOtpVerifyInput),
  authController.verifyOtp
);

router.post(
  "/password/forgot",
  otpRateLimiter,
  validateMiddleware(validateForgotPasswordInput),
  authController.forgotPassword
);
router.post(
  "/password/reset",
  authRateLimiter,
  validateMiddleware(validateResetPasswordInput),
  authController.resetPassword
);

router.post(
  "/refresh",
  authRateLimiter,
  validateMiddleware(validateRefreshInput),
  authController.refresh
);
router.post(
  "/logout",
  authMiddleware,
  validateMiddleware(validateLogoutInput),
  authController.logout
);

module.exports = router;
