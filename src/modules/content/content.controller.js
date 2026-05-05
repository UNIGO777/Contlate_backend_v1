const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const contentService = require("./content.service");

const createContent = asyncHandler(async (req, res) => {
  const content = await contentService.createContent({
    userId: req.user.id,
    businessId: req.business._id.toString(),
    payload: req.validated,
  });

  return res.status(201).json(new ApiResponse(201, { content }, "Content created successfully."));
});

const listMyContent = asyncHandler(async (req, res) => {
  const items = await contentService.listContentByUserId(req.user.id);

  return res
    .status(200)
    .json(new ApiResponse(200, { items }, "Content list fetched successfully."));
});

const getMyContentById = asyncHandler(async (req, res) => {
  const content = await contentService.getContentById({
    userId: req.user.id,
    contentId: req.params.contentId,
  });

  return res.status(200).json(new ApiResponse(200, { content }, "Content fetched successfully."));
});

const updateMyContent = asyncHandler(async (req, res) => {
  const content = await contentService.updateContent({
    userId: req.user.id,
    contentId: req.params.contentId,
    payload: req.validated,
  });

  return res.status(200).json(new ApiResponse(200, { content }, "Content updated successfully."));
});

const deleteMyContent = asyncHandler(async (req, res) => {
  const content = await contentService.deleteContent({
    userId: req.user.id,
    contentId: req.params.contentId,
  });

  return res.status(200).json(new ApiResponse(200, { content }, "Content deleted successfully."));
});

module.exports = {
  createContent,
  listMyContent,
  getMyContentById,
  updateMyContent,
  deleteMyContent,
};
