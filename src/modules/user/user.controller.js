const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const asyncHandler = require("../../core/asyncHandler");
const userService = require("./user.service");
const User = require("./user.model");

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

// ── POST /user/me/push-token ─────────────────────────────────────────────────
// Register or refresh an Expo push token for this device.
const registerPushToken = asyncHandler(async (req, res) => {
  const { token, device } = req.body;

  if (!token || typeof token !== "string") {
    throw new ApiError(400, "token is required.");
  }

  // Remove any existing entry for this token, then push the refreshed one.
  // This keeps the array clean even if the same device re-registers.
  await User.updateOne(
    { _id: req.user._id },
    {
      $pull: { expoPushTokens: { token } },
    }
  );
  await User.updateOne(
    { _id: req.user._id },
    {
      $push: {
        expoPushTokens: {
          $each: [{ token, device: device ?? null, createdAt: new Date() }],
          $slice: -10, // keep at most 10 tokens per user
        },
      },
    }
  );

  return res.json(new ApiResponse(200, null, "Push token registered."));
});

// ── DELETE /user/me/push-token ───────────────────────────────────────────────
// Remove a push token on logout / permission revoke.
const removePushToken = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (token) {
    await User.updateOne({ _id: req.user._id }, { $pull: { expoPushTokens: { token } } });
  }
  return res.json(new ApiResponse(200, null, "Push token removed."));
});

module.exports = { me, updateMe, changePassword, changeEmail, deleteMe, registerPushToken, removePushToken };
