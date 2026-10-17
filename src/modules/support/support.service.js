const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const Ticket = require("./support.model");
const { TICKET_STATUS } = Ticket;

const sanitize = (t) => ({
  id: t._id.toString(),
  subject: t.subject,
  category: t.category,
  status: t.status,
  messages: (t.messages || []).map((m) => ({
    id: m._id.toString(),
    from: m.from,
    body: m.body,
    createdAt: m.createdAt,
  })),
  lastMessageAt: t.lastMessageAt,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

// The list does not need every message, only enough to preview the thread.
const sanitizeSummary = (t) => {
  const last = (t.messages || [])[t.messages.length - 1];
  return {
    id: t._id.toString(),
    subject: t.subject,
    category: t.category,
    status: t.status,
    messageCount: (t.messages || []).length,
    lastMessage: last ? { from: last.from, body: last.body, createdAt: last.createdAt } : null,
    lastMessageAt: t.lastMessageAt,
    createdAt: t.createdAt,
  };
};

const ownedOrFail = async (userId, ticketId) => {
  const ticket = await Ticket.findOne({ _id: ticketId, userId });
  if (!ticket) {
    throw new ApiError(404, "Ticket not found.", { code: ERROR_CODES.NOT_FOUND });
  }
  return ticket;
};

const create = async (userId, businessId, { subject, category, message, context }) => {
  const now = new Date();
  const ticket = await Ticket.create({
    userId,
    businessId: businessId || null,
    subject,
    category: category || "other",
    status: TICKET_STATUS.OPEN,
    messages: [{ from: "user", body: message, createdAt: now }],
    lastMessageAt: now,
    context: {
      appVersion: context?.appVersion || "",
      platform: context?.platform || "",
    },
  });
  return sanitize(ticket);
};

const list = async (userId, { status, page = 1, limit = 20 } = {}) => {
  const q = { userId };
  if (status) q.status = status;
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    Ticket.find(q).sort({ lastMessageAt: -1 }).skip(skip).limit(limit),
    Ticket.countDocuments(q),
  ]);
  return { data: rows.map(sanitizeSummary), page, limit, total };
};

const getById = async (userId, ticketId) => sanitize(await ownedOrFail(userId, ticketId));

const reply = async (userId, ticketId, { message }) => {
  const ticket = await ownedOrFail(userId, ticketId);
  if (ticket.status === TICKET_STATUS.CLOSED) {
    throw new ApiError(400, "This ticket is closed. Please open a new one.", {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }

  const now = new Date();
  ticket.messages.push({ from: "user", body: message, createdAt: now });
  ticket.lastMessageAt = now;
  // A reply from the user puts the ball back in support's court, including on
  // a ticket that had been marked resolved.
  ticket.status = TICKET_STATUS.OPEN;
  await ticket.save();
  return sanitize(ticket);
};

const close = async (userId, ticketId) => {
  const ticket = await ownedOrFail(userId, ticketId);
  if (ticket.status === TICKET_STATUS.CLOSED) return sanitize(ticket);
  ticket.status = TICKET_STATUS.CLOSED;
  await ticket.save();
  return sanitize(ticket);
};

module.exports = { create, list, getById, reply, close };
