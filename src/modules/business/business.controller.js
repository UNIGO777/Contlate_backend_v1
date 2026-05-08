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

const startSetup = asyncHandler(async (req, res) => {
  const business = await businessService.startSetup(req.user.id, req.validated);
  return res.status(200).json(new ApiResponse(200, { business }, "Business setup started."));
});

const saveSetupAddress = asyncHandler(async (req, res) => {
  const business = await businessService.saveSetupAddress(req.user.id, req.validated);
  return res.status(200).json(new ApiResponse(200, { business }, "Business address saved."));
});

const matchSetupPlaces = asyncHandler(async (req, res) => {
  const results = await businessService.matchSetupPlaces(req.validated);
  return res.status(200).json(new ApiResponse(200, { results }, "Business matches fetched."));
});

const selectSetupPlace = asyncHandler(async (req, res) => {
  const result = await businessService.selectSetupPlace(req.user.id, req.validated);
  return res.status(200).json(new ApiResponse(200, result, "Google business selected."));
});

const completeSetup = asyncHandler(async (req, res) => {
  const business = await businessService.completeSetup(req.user.id, req.validated);
  return res.status(200).json(new ApiResponse(200, { business }, "Business setup completed."));
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

const uploadLogo = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json(new ApiResponse(400, null, "No file uploaded. Send a multipart/form-data request with a 'file' field."));
  }
  const result = await businessService.uploadLogo(req.user.id, req.file.buffer, req.file.mimetype);
  return res.status(200).json(new ApiResponse(200, result, "Logo uploaded successfully."));
});

const generateThemes = asyncHandler(async (req, res) => {
  const hasLogo = req.body?.hasLogo === true || req.body?.hasLogo === "true";
  const logoUrl  = typeof req.body?.logoUrl === "string" ? req.body.logoUrl.trim() : "";
  const result = await businessService.generateThemes(req.user.id, { hasLogo, logoUrl });
  return res.status(200).json(new ApiResponse(200, result, "Themes generated successfully."));
});

module.exports = {
  createBusiness,
  getMyBusiness,
  updateMyBusiness,
  updateBrandAssets,
  startSetup,
  saveSetupAddress,
  matchSetupPlaces,
  selectSetupPlace,
  completeSetup,
  refreshGoogle,
  searchPlaces,
  generateDescription,
  uploadLogo,
  generateThemes,
};
