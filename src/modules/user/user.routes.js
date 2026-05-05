const express = require("express");
const validateMiddleware = require("../../middlewares/validate.middleware");
const userController = require("./user.controller");
const {
  validateUpdateProfile,
  validateChangePassword,
  validateChangeEmail,
} = require("./user.validation");

const router = express.Router();

router.get("/me", userController.me);
router.patch("/me", validateMiddleware(validateUpdateProfile), userController.updateMe);
router.patch(
  "/me/password",
  validateMiddleware(validateChangePassword),
  userController.changePassword
);
router.patch("/me/email", validateMiddleware(validateChangeEmail), userController.changeEmail);
router.delete("/me", userController.deleteMe);

module.exports = router;
