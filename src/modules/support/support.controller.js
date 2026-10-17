const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const supportService = require("./support.service");

const createTicket = asyncHandler(async (req, res) => {
  // Support is reachable before a business is set up, so businessId is optional.
  const result = await supportService.create(
    req.user.id,
    req.business?._id || null,
    req.validated
  );
  return res.status(201).json(new ApiResponse(201, result, "Ticket created."));
});

const listTickets = asyncHandler(async (req, res) => {
  const page = Number.parseInt(req.query.page, 10) || 1;
  const limit = Math.min(50, Number.parseInt(req.query.limit, 10) || 20);
  const result = await supportService.list(req.user.id, {
    status: req.query.status,
    page,
    limit,
  });
  return res.status(200).json(new ApiResponse(200, result, "Tickets fetched."));
});

const getTicket = asyncHandler(async (req, res) => {
  const result = await supportService.getById(req.user.id, req.params.ticketId);
  return res.status(200).json(new ApiResponse(200, result, "Ticket fetched."));
});

const replyToTicket = asyncHandler(async (req, res) => {
  const result = await supportService.reply(req.user.id, req.params.ticketId, req.validated);
  return res.status(200).json(new ApiResponse(200, result, "Reply sent."));
});

const closeTicket = asyncHandler(async (req, res) => {
  const result = await supportService.close(req.user.id, req.params.ticketId);
  return res.status(200).json(new ApiResponse(200, result, "Ticket closed."));
});

module.exports = { createTicket, listTickets, getTicket, replyToTicket, closeTicket };
