const mongoose = require("mongoose");

/**
 * Audit log for every Meta webhook event received.
 * Used for:
 *   - Idempotency: skip re-processing of duplicate events
 *   - Debugging: full payload preserved for 90 days
 *   - Monitoring: track delivery rate, processing time, failures
 */
const webhookEventSchema = new mongoose.Schema(
  {
    // Unique ID we generate on receipt — used as BullMQ jobId for deduplication
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Meta payload fields
    object: { type: String, default: "" },       // "page", "user", "permissions", "instagram"
    entryId: { type: String, index: true },       // Page ID or User ID from entry[].id
    field: { type: String, default: "" },         // "feed", "permission", etc.
    verb: { type: String, default: "" },          // "add", "remove", "granted", "revoked"

    // Processing lifecycle
    status: {
      type: String,
      enum: ["received", "processing", "processed", "failed", "ignored"],
      default: "received",
      index: true,
    },
    processedAt: { type: Date },
    errorMessage: { type: String, default: "" },

    // What action was taken as a result
    action: { type: String, default: "" },        // "account_expired", "account_disconnected", etc.
    affectedAccountIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "SocialAccount" }],
    affectedUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    // Data deletion specific
    confirmationCode: { type: String, default: "" },
    externalUserId: { type: String, default: "" },

    // Full raw payload for debugging
    rawPayload: { type: mongoose.Schema.Types.Mixed },

    receivedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

webhookEventSchema.index({ receivedAt: -1 });
// TTL — auto-delete processed events after 90 days
webhookEventSchema.index(
  { processedAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 }
);

module.exports = mongoose.model("WebhookEvent", webhookEventSchema);
