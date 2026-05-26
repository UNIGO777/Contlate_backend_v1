const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const socialService = require("./social.service");

const connectSocialAccount = asyncHandler(async (req, res) => {
  const socialAccount = await socialService.connectSocialAccount({
    userId: req.user.id,
    businessId: req.business._id.toString(),
    payload: req.validated,
  });

  return res
    .status(201)
    .json(new ApiResponse(201, { socialAccount }, "Social account connected successfully."));
});

const listMySocialAccounts = asyncHandler(async (req, res) => {
  const items = await socialService.listSocialAccountsByUserId(req.user.id);

  return res
    .status(200)
    .json(new ApiResponse(200, { items }, "Social accounts fetched successfully."));
});

const getMySocialAccountById = asyncHandler(async (req, res) => {
  const socialAccount = await socialService.getSocialAccountById({
    userId: req.user.id,
    socialAccountId: req.params.socialAccountId,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, { socialAccount }, "Social account fetched successfully."));
});

const updateMySocialAccount = asyncHandler(async (req, res) => {
  const socialAccount = await socialService.updateSocialAccount({
    userId: req.user.id,
    socialAccountId: req.params.socialAccountId,
    payload: req.validated,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, { socialAccount }, "Social account updated successfully."));
});

const disconnectMySocialAccount = asyncHandler(async (req, res) => {
  const socialAccount = await socialService.disconnectSocialAccount({
    userId: req.user.id,
    socialAccountId: req.params.socialAccountId,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, { socialAccount }, "Social account disconnected successfully."));
});

const deleteMySocialAccount = asyncHandler(async (req, res) => {
  await socialService.deleteSocialAccount({
    userId: req.user.id,
    socialAccountId: req.params.socialAccountId,
  });

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Social account deleted successfully."));
});

module.exports = {
  connectSocialAccount,
  listMySocialAccounts,
  getMySocialAccountById,
  updateMySocialAccount,
  disconnectMySocialAccount,
  deleteMySocialAccount,
};
