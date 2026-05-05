const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const adminService = require("./admin.service");

const parsePage = (req) => ({
  page: Number.parseInt(req.query.page, 10) || 1,
  limit: Math.min(200, Number.parseInt(req.query.limit, 10) || 20),
});

const listUsers = asyncHandler(async (req, res) => {
  const { page, limit } = parsePage(req);
  const { q, plan, role } = req.query;
  const result = await adminService.listUsers({ page, limit, q, plan, role });
  return res.status(200).json(new ApiResponse(200, result, "Users fetched."));
});

const getUser = asyncHandler(async (req, res) => {
  const result = await adminService.getUserDetail(req.params.userId);
  return res.status(200).json(new ApiResponse(200, result, "User detail fetched."));
});

const suspendUser = asyncHandler(async (req, res) => {
  const result = await adminService.setUserSuspension(req.params.userId, true);
  return res.status(200).json(new ApiResponse(200, result, "User suspended."));
});

const unsuspendUser = asyncHandler(async (req, res) => {
  const result = await adminService.setUserSuspension(req.params.userId, false);
  return res.status(200).json(new ApiResponse(200, result, "User unsuspended."));
});

const listSubscriptions = asyncHandler(async (req, res) => {
  const { page, limit } = parsePage(req);
  const { status, plan } = req.query;
  const result = await adminService.listSubscriptions({ page, limit, status, plan });
  return res.status(200).json(new ApiResponse(200, result, "Subscriptions fetched."));
});

const listSchedules = asyncHandler(async (req, res) => {
  const { page, limit } = parsePage(req);
  const { status, userId } = req.query;
  const result = await adminService.listSchedules({ page, limit, status, userId });
  return res.status(200).json(new ApiResponse(200, result, "Schedules fetched."));
});

const retrySchedule = asyncHandler(async (req, res) => {
  const result = await adminService.retrySchedule(req.params.scheduleId);
  return res.status(200).json(new ApiResponse(200, result, "Schedule queued for retry."));
});

const listJobLogs = asyncHandler(async (req, res) => {
  const { page, limit } = parsePage(req);
  const { type, status } = req.query;
  const result = await adminService.listJobLogs({ page, limit, type, status });
  return res.status(200).json(new ApiResponse(200, result, "Job logs fetched."));
});

const listPaymentEvents = asyncHandler(async (req, res) => {
  const { page, limit } = parsePage(req);
  const { provider, processed } = req.query;
  const result = await adminService.listPaymentEvents({ page, limit, provider, processed });
  return res.status(200).json(new ApiResponse(200, result, "Payment events fetched."));
});

const getStats = asyncHandler(async (_req, res) => {
  const result = await adminService.getStats();
  return res.status(200).json(new ApiResponse(200, result, "Stats fetched."));
});

const editUserSubscription = asyncHandler(async (req, res) => {
  const { plan, status, endsAt } = req.body;
  const result = await adminService.editUserSubscription(req.params.userId, { plan, status, endsAt });
  return res.status(200).json(new ApiResponse(200, result, "Subscription updated."));
});

const grantUserPlan = asyncHandler(async (req, res) => {
  const { plan, endsAt } = req.body;
  const result = await adminService.grantUserPlan(req.user.id, req.params.userId, { plan, endsAt });
  return res.status(200).json(new ApiResponse(200, result, "Plan granted."));
});

module.exports = {
  listUsers,
  getUser,
  suspendUser,
  unsuspendUser,
  editUserSubscription,
  grantUserPlan,
  listSubscriptions,
  listSchedules,
  retrySchedule,
  listJobLogs,
  listPaymentEvents,
  getStats,
};
