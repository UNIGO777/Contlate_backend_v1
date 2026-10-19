const ApiError = require("../../core/ApiError");
const logger = require("../../core/logger");
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

// ── Admin side ──────────────────────────────────────────────────────────────
// Users could raise tickets but nobody could answer them: every message was
// written with from: "user", and nothing could write from: "support". These
// are the other half of that conversation.

const adminList = async ({ status, q, page = 1, limit = 20 } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ subject: rx }, { "messages.body": rx }];
  }

  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    Ticket.find(filter)
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "name email plan")
      .lean(),
    Ticket.countDocuments(filter),
  ]);

  const open = await Ticket.countDocuments({
    status: { $in: [TICKET_STATUS.OPEN, TICKET_STATUS.AWAITING_USER] },
  });

  return {
    data: rows.map((t) => {
      const last = (t.messages || [])[t.messages.length - 1];
      return {
        id: t._id.toString(),
        subject: t.subject,
        category: t.category,
        status: t.status,
        // Who raised it, so the queue can be triaged without opening each one.
        user: t.userId
          ? { id: String(t.userId._id), name: t.userId.name, email: t.userId.email, plan: t.userId.plan }
          : null,
        messageCount: (t.messages || []).length,
        // Whether the ball is in our court.
        waitingOnUs: last ? last.from === "user" : true,
        lastMessage: last ? { from: last.from, body: last.body, createdAt: last.createdAt } : null,
        lastMessageAt: t.lastMessageAt,
        context: t.context,
        createdAt: t.createdAt,
      };
    }),
    page,
    limit,
    total,
    openCount: open,
  };
};

const adminGet = async (ticketId) => {
  const ticket = await Ticket.findById(ticketId).populate("userId", "name email plan createdAt");
  if (!ticket) {
    throw new ApiError(404, "Ticket not found.", { code: ERROR_CODES.NOT_FOUND });
  }
  return {
    ...sanitize(ticket),
    user: ticket.userId
      ? {
          id: String(ticket.userId._id),
          name: ticket.userId.name,
          email: ticket.userId.email,
          plan: ticket.userId.plan,
          joinedAt: ticket.userId.createdAt,
        }
      : null,
    context: ticket.context,
  };
};

const adminReply = async (ticketId, { message, resolve }) => {
  const ticket = await Ticket.findById(ticketId);
  if (!ticket) {
    throw new ApiError(404, "Ticket not found.", { code: ERROR_CODES.NOT_FOUND });
  }

  const now = new Date();
  ticket.messages.push({ from: "support", body: message, createdAt: now });
  ticket.lastMessageAt = now;
  // Answering hands the ticket back to the user, unless it is being closed
  // out as resolved.
  ticket.status = resolve ? TICKET_STATUS.RESOLVED : TICKET_STATUS.AWAITING_USER;
  await ticket.save();

  // Tell them there is an answer waiting — otherwise they only find out if
  // they happen to reopen the app.
  try {
    const { sendAppNotification } = require("../../utils/notifications");
    const User = require("../user/user.model");
    const user = await User.findById(ticket.userId).select("email name").lean();
    sendAppNotification(
      ticket.userId,
      "GENERAL",
      { title: "Support replied", body: `Re: ${ticket.subject}` },
      user ? { userEmail: user.email, userName: user.name } : {}
    );
  } catch (err) {
    logger.warn("[support] reply notification failed", { message: err.message });
  }

  return sanitize(ticket);
};

const adminSetStatus = async (ticketId, status) => {
  if (!Object.values(TICKET_STATUS).includes(status)) {
    throw new ApiError(400, "Unknown status.", { code: ERROR_CODES.VALIDATION_FAILED });
  }
  const ticket = await Ticket.findByIdAndUpdate(
    ticketId,
    { $set: { status } },
    { returnDocument: "after" }
  );
  if (!ticket) {
    throw new ApiError(404, "Ticket not found.", { code: ERROR_CODES.NOT_FOUND });
  }
  return sanitize(ticket);
};

module.exports = {
  create,
  list,
  getById,
  reply,
  close,
  adminList,
  adminGet,
  adminReply,
  adminSetStatus,
};
