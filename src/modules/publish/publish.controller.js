const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const publishService = require("./publish.service");

/**
 * POST /publish/now
 * Publish content immediately to one or more social accounts.
 * Body: { contentId, socialAccountIds: ["...", "..."] }
 */
const publishNow = asyncHandler(async (req, res) => {
  const { contentId, socialAccountIds } = req.body;

  const results = await publishService.publishNow(
    req.user._id,
    req.business._id,
    { contentId, socialAccountIds }
  );

  const successCount = results.filter((r) => r.status === "success").length;
  const failCount = results.filter((r) => r.status === "failed").length;

  let message = "Published successfully.";
  if (successCount > 0 && failCount > 0) {
    message = `Published to ${successCount} account(s). ${failCount} failed.`;
  } else if (failCount > 0 && successCount === 0) {
    message = "Publishing failed for all accounts.";
  }

  return res.status(200).json(
    new ApiResponse(200, { results, successCount, failCount }, message)
  );
});

/**
 * GET /publish/log
 * List publish history for the current user.
 * Query: page, limit, platform, status, publishType
 */
const listLogs = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, platform, status, publishType } = req.query;

  const result = await publishService.listLogs(req.user._id, {
    page: Number(page),
    limit: Math.min(Number(limit), 50),
    platform,
    status,
    publishType,
  });

  return res.status(200).json(new ApiResponse(200, result, "Publish logs fetched."));
});

/**
 * GET /publish/log/:scheduleId
 * Get all publish attempts for a specific schedule.
 */
const getLogsBySchedule = asyncHandler(async (req, res) => {
  const { scheduleId } = req.params;

  const logs = await publishService.getLogsBySchedule(req.user._id, scheduleId);

  return res.status(200).json(new ApiResponse(200, { logs }, "Schedule logs fetched."));
});

module.exports = { publishNow, listLogs, getLogsBySchedule };
