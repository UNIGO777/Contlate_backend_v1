const mongoose = require("mongoose");

const TICKET_STATUS = Object.freeze({
  OPEN: "open",
  AWAITING_USER: "awaiting_user",
  RESOLVED: "resolved",
  CLOSED: "closed",
});

const TICKET_CATEGORIES = Object.freeze([
  "posting",
  "billing",
  "account",
  "bug",
  "other",
]);

// One exchange on a ticket. Kept inline rather than in its own collection:
// a support thread is short, always read whole, and never queried on its own.
const messageSchema = new mongoose.Schema(
  {
    from: { type: String, enum: ["user", "support"], required: true },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true, versionKey: false }
);

const ticketSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      default: null,
    },
    subject: { type: String, required: true, trim: true, maxlength: 140 },
    category: { type: String, enum: TICKET_CATEGORIES, default: "other" },
    status: {
      type: String,
      enum: Object.values(TICKET_STATUS),
      default: TICKET_STATUS.OPEN,
      index: true,
    },
    messages: { type: [messageSchema], default: [] },
    // Denormalised so the ticket list can sort without touching the thread.
    lastMessageAt: { type: Date, default: Date.now },
    // What the user was running when they wrote in — saves a round trip of
    // "which version are you on?" on every bug report.
    context: {
      appVersion: { type: String, default: "" },
      platform: { type: String, default: "" },
    },
  },
  { timestamps: true, versionKey: false }
);

ticketSchema.index({ userId: 1, lastMessageAt: -1 });

module.exports = mongoose.model("SupportTicket", ticketSchema);
module.exports.TICKET_STATUS = TICKET_STATUS;
module.exports.TICKET_CATEGORIES = TICKET_CATEGORIES;
