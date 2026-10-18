const mongoose = require("mongoose");

const GBP_POST_STATUS = Object.freeze({
  DRAFT: "draft",          // written, poster not ready yet
  READY: "ready",          // poster + copy done, waiting for its slot
  PUBLISHING: "publishing",
  PUBLISHED: "published",
  FAILED: "failed",
  DECLINED: "declined",    // user said no before the deadline
  SKIPPED: "skipped",      // autopilot off, or no keyword to target that day
});

/**
 * One Google Business Profile post, built around a keyword the business is
 * trying to rank for.
 *
 * Kept separate from Content/Schedule on purpose: a GBP post is not a social
 * post. It has its own body limits, its own call-to-action vocabulary, it
 * expires after seven days on Google's side, and it is published through a
 * different API. Folding it into the social pipeline would have meant
 * special-casing every step of that pipeline.
 */
const gbpPostSchema = new mongoose.Schema(
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
      required: true,
      index: true,
    },

    // What this post is trying to rank for.
    keyword: { type: String, trim: true, default: "" },

    summary: { type: String, trim: true, default: "" },   // the post body
    imageUrl: { type: String, default: "" },
    localImagePath: { type: String, default: "" },
    localImageDeleted: { type: Boolean, default: false },

    callToAction: {
      // Google's own vocabulary for these.
      actionType: { type: String, default: "LEARN_MORE" },
      url: { type: String, default: "" },
    },

    status: {
      type: String,
      enum: Object.values(GBP_POST_STATUS),
      default: GBP_POST_STATUS.DRAFT,
      index: true,
    },

    scheduledFor: { type: Date, default: null, index: true },
    // Two hours before the slot, matching the social plan. After this the
    // post is committed — Google is about to be told about it.
    declineDeadlineAt: { type: Date, default: null },
    declinedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },

    // Google's identifier, needed to read back metrics or delete the post.
    googlePostName: { type: String, default: "" },
    googleSearchUrl: { type: String, default: "" },

    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: "" },

    // Metrics Google reports for this specific post. Filled in later by the
    // insights sync, which is why they are nullable rather than zero —
    // "not measured yet" and "nobody looked" are different things.
    metrics: {
      views: { type: Number, default: null },
      clicks: { type: Number, default: null },
      lastSyncedAt: { type: Date, default: null },
    },

    generationCost: {
      gptCost: { type: Number, default: 0 },
      imageCost: { type: Number, default: 0 },
      totalCost: { type: Number, default: 0 },
    },
  },
  { timestamps: true, versionKey: false }
);

gbpPostSchema.index({ businessId: 1, scheduledFor: -1 });
gbpPostSchema.index({ status: 1, scheduledFor: 1 });

module.exports = mongoose.model("GbpPost", gbpPostSchema);
module.exports.GBP_POST_STATUS = GBP_POST_STATUS;
