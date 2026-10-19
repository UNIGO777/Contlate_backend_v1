const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
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

const sendEmailBlast = asyncHandler(async (req, res) => {
  const { audience, subject, body } = req.body || {};
  const result = await adminService.sendEmailBlast(req.user.id, { audience, subject, body });
  return res.status(200).json(new ApiResponse(200, result, "Email blast queued."));
});

const getEmailBlastContext = asyncHandler(async (_req, res) => {
  const result = await adminService.getEmailBlastContext();
  return res.status(200).json(new ApiResponse(200, result, "Email context fetched."));
});

const listAdminNotifications = asyncHandler(async (req, res) => {
  const { limit, type } = req.query;
  const data = await adminService.listAdminNotifications({
    limit: limit ? Number(limit) : undefined,
    type,
  });
  return res.status(200).json(new ApiResponse(200, { data }, "Notifications fetched."));
});

// ── Support ─────────────────────────────────────────────────────────────────
const supportService = require("../support/support.service");

const listTickets = asyncHandler(async (req, res) => {
  const page = Number.parseInt(req.query.page, 10) || 1;
  const limit = Math.min(50, Number.parseInt(req.query.limit, 10) || 20);
  const result = await supportService.adminList({
    status: req.query.status,
    q: req.query.q,
    page,
    limit,
  });
  return res.status(200).json(new ApiResponse(200, result, "Tickets fetched."));
});

const getTicket = asyncHandler(async (req, res) => {
  const result = await supportService.adminGet(req.params.ticketId);
  return res.status(200).json(new ApiResponse(200, result, "Ticket fetched."));
});

const replyToTicket = asyncHandler(async (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) {
    throw new ApiError(400, "message is required.", { code: ERROR_CODES.VALIDATION_FAILED });
  }
  const result = await supportService.adminReply(req.params.ticketId, {
    message: message.slice(0, 4000),
    resolve: Boolean(req.body?.resolve),
  });
  return res.status(200).json(new ApiResponse(200, result, "Reply sent."));
});

const setTicketStatus = asyncHandler(async (req, res) => {
  const result = await supportService.adminSetStatus(req.params.ticketId, req.body?.status);
  return res.status(200).json(new ApiResponse(200, result, "Status updated."));
});

const listPlans = asyncHandler(async (req, res) => {
  const page = Number.parseInt(req.query.page, 10) || 1;
  const limit = Math.min(50, Number.parseInt(req.query.limit, 10) || 20);
  const result = await adminService.listPlans({ page, limit, status: req.query.status });
  return res.status(200).json(new ApiResponse(200, result, "Plans fetched."));
});

const listGbpPosts = asyncHandler(async (req, res) => {
  const page = Number.parseInt(req.query.page, 10) || 1;
  const limit = Math.min(50, Number.parseInt(req.query.limit, 10) || 20);
  const result = await adminService.listGbpPosts({ page, limit, status: req.query.status });
  return res.status(200).json(new ApiResponse(200, result, "GBP posts fetched."));
});

const listSeo = asyncHandler(async (req, res) => {
  const page = Number.parseInt(req.query.page, 10) || 1;
  const limit = Math.min(50, Number.parseInt(req.query.limit, 10) || 20);
  const result = await adminService.listSeo({ page, limit });
  return res.status(200).json(new ApiResponse(200, result, "SEO data fetched."));
});

const listUserContent = asyncHandler(async (req, res) => {
  const page = Number.parseInt(req.query.page, 10) || 1;
  const limit = Math.min(48, Number.parseInt(req.query.limit, 10) || 24);
  const result = await adminService.listUserContent(req.params.userId, { page, limit });
  return res.status(200).json(new ApiResponse(200, result, "Content fetched."));
});

const listContent = asyncHandler(async (req, res) => {
  const page = Number.parseInt(req.query.page, 10) || 1;
  const limit = Math.min(48, Number.parseInt(req.query.limit, 10) || 24);
  const result = await adminService.listContent({ page, limit, status: req.query.status });
  return res.status(200).json(new ApiResponse(200, result, "Content fetched."));
});

module.exports = {
  listContent,
  listUserContent,
  listSeo,
  listPlans,
  listGbpPosts,
  listTickets,
  getTicket,
  replyToTicket,
  setTicketStatus,
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
  sendEmailBlast,
  getEmailBlastContext,
  listAdminNotifications,
};
