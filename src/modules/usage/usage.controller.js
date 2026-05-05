const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const usageService = require("./usage.service");

const getMyUsage = asyncHandler(async (req, res) => {
  const usage = await usageService.getUsageSummary(req.user.id);
  return res.status(200).json(new ApiResponse(200, usage, "Usage fetched successfully."));
});

const getMyUsageHistory = asyncHandler(async (req, res) => {
  const { from, to } = req.query || {};
  const rows = await usageService.getUsageHistory(req.user.id, { from, to });
  return res.status(200).json(
    new ApiResponse(200, { data: rows, total: rows.length }, "Usage history fetched.")
  );
});

module.exports = { getMyUsage, getMyUsageHistory };
