const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const businessService = require("./business.service");

const createBusiness = asyncHandler(async (req, res) => {
  const business = await businessService.createBusiness(req.user.id, req.validated);
  return res
    .status(201)
    .json(new ApiResponse(201, { business }, "Business profile created successfully."));
});

const getMyBusiness = asyncHandler(async (req, res) => {
  const business = await businessService.getBusinessByUserId(req.user.id);
  return res.status(200).json(new ApiResponse(200, { business }, "Business profile fetched."));
});

const updateMyBusiness = asyncHandler(async (req, res) => {
  const business = await businessService.updateBusiness(req.user.id, req.validated);
  return res.status(200).json(new ApiResponse(200, { business }, "Business profile updated."));
});

const updateBrandAssets = asyncHandler(async (req, res) => {
  const business = await businessService.updateBrandAssets(req.user.id, req.validated);
  return res.status(200).json(new ApiResponse(200, { business }, "Brand assets updated."));
});

const refreshGoogle = asyncHandler(async (req, res) => {
  const placeId =
    typeof req.body?.placeId === "string" ? req.body.placeId.trim() : undefined;
  const business = await businessService.refreshGoogle(req.user.id, { placeId });
  return res
    .status(200)
    .json(new ApiResponse(200, { business }, "Google details refreshed."));
});

const searchPlaces = asyncHandler(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const results = await businessService.searchPlaces(q);
  return res.status(200).json(new ApiResponse(200, { results }, "Places search results."));
});

const generateDescription = asyncHandler(async (req, res) => {
  const { placeId, description } = req.body || {};
  const result = await businessService.generateDescription({ placeId, description });
  return res.status(200).json(new ApiResponse(200, result, "Description generated."));
});

module.exports = {
  createBusiness,
  getMyBusiness,
  updateMyBusiness,
  updateBrandAssets,
  refreshGoogle,
  searchPlaces,
  generateDescription,
};
