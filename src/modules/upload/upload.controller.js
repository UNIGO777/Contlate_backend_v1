const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const uploadService = require("./upload.service");

const prepareUpload = asyncHandler(async (req, res) => {
  const result = await uploadService.prepare(req.user.id, req.validated);
  return res.status(200).json(new ApiResponse(200, result, "Upload target prepared."));
});

const confirmUpload = asyncHandler(async (req, res) => {
  const result = await uploadService.confirm(req.user.id, req.validated);
  return res.status(200).json(new ApiResponse(200, result, "Upload confirmed."));
});

const listUploads = asyncHandler(async (req, res) => {
  const page = Number.parseInt(req.query.page, 10) || 1;
  const limit = Math.min(100, Number.parseInt(req.query.limit, 10) || 20);
  const purpose = req.query.purpose;
  const result = await uploadService.list(req.user.id, { page, limit, purpose });
  return res.status(200).json(new ApiResponse(200, result, "Uploads fetched."));
});

const deleteUpload = asyncHandler(async (req, res) => {
  const result = await uploadService.remove(req.user.id, req.params.mediaAssetId);
  return res.status(200).json(new ApiResponse(200, result, "Upload deleted."));
});

module.exports = { prepareUpload, confirmUpload, listUploads, deleteUpload };
