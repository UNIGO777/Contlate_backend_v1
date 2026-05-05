const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const userService = require("./user.service");

const me = asyncHandler(async (req, res) => {
  const data = await userService.getProfile(req.user.id);
  return res.status(200).json(new ApiResponse(200, data, "Profile fetched."));
});

const updateMe = asyncHandler(async (req, res) => {
  const data = await userService.updateProfile(req.user.id, req.validated);
  return res.status(200).json(new ApiResponse(200, data, "Profile updated."));
});

const changePassword = asyncHandler(async (req, res) => {
  const data = await userService.changePassword(req.user.id, req.validated);
  return res.status(200).json(new ApiResponse(200, data, "Password changed."));
});

const changeEmail = asyncHandler(async (req, res) => {
  const data = await userService.changeEmail(req.user.id, req.validated);
  return res.status(200).json(new ApiResponse(200, data, "Email changed. Verify to activate."));
});

const deleteMe = asyncHandler(async (req, res) => {
  const data = await userService.deleteAccount(req.user.id);
  return res.status(200).json(new ApiResponse(200, data, "Account deleted."));
});

module.exports = { me, updateMe, changePassword, changeEmail, deleteMe };
