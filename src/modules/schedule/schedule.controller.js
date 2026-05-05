const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const scheduleService = require("./schedule.service");

const createSchedule = asyncHandler(async (req, res) => {
  const result = await scheduleService.create(
    req.user.id,
    req.business._id,
    req.validated
  );
  return res.status(201).json(new ApiResponse(201, result, "Schedule created."));
});

const bulkCreateSchedules = asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) {
    return res.status(400).json(new ApiResponse(400, null, "items array is required and must not be empty."));
  }
  if (items.length > 28) {
    return res.status(400).json(new ApiResponse(400, null, "Bulk create is limited to 28 items per request."));
  }
  const results = await scheduleService.bulkCreate(req.user.id, req.business._id, items);
  const created = results.filter((r) => r.schedule).length;
  return res
    .status(207)
    .json(new ApiResponse(207, { results, created, total: items.length }, `${created}/${items.length} schedules created.`));
});

const listSchedules = asyncHandler(async (req, res) => {
  const page   = Number.parseInt(req.query.page, 10)  || 1;
  const limit  = Math.min(100, Number.parseInt(req.query.limit, 10) || 20);
  const status = req.query.status;
  const from   = req.query.from;
  const to     = req.query.to;
  const result = await scheduleService.list(req.user.id, { page, limit, status, from, to });
  return res.status(200).json(new ApiResponse(200, result, "Schedules fetched."));
});

const getScheduleById = asyncHandler(async (req, res) => {
  const result = await scheduleService.getById(req.user.id, req.params.scheduleId);
  return res.status(200).json(new ApiResponse(200, result, "Schedule fetched."));
});

const updateSchedule = asyncHandler(async (req, res) => {
  const result = await scheduleService.update(
    req.user.id,
    req.params.scheduleId,
    req.validated
  );
  return res.status(200).json(new ApiResponse(200, result, "Schedule updated."));
});

const cancelSchedule = asyncHandler(async (req, res) => {
  const result = await scheduleService.cancel(req.user.id, req.params.scheduleId);
  return res.status(200).json(new ApiResponse(200, result, "Schedule cancelled."));
});

module.exports = {
  createSchedule,
  bulkCreateSchedules,
  listSchedules,
  getScheduleById,
  updateSchedule,
  cancelSchedule,
};
