const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const dashboardService = require("./dashboard.service");

const getMyOverview = asyncHandler(async (req, res) => {
  const result = await dashboardService.getOverview(req.user.id);
  return res.status(200).json(new ApiResponse(200, result, "Overview fetched."));
});

const getMyPublishTrend = asyncHandler(async (req, res) => {
  const days = Math.min(60, Math.max(1, Number.parseInt(req.query.days, 10) || 14));
  const result = await dashboardService.getPublishTrend(req.user.id, { days });
  return res.status(200).json(new ApiResponse(200, result, "Publish trend fetched."));
});

module.exports = { getMyOverview, getMyPublishTrend };
