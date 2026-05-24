const mongoose = require("mongoose");

const publishLogSchema = new mongoose.Schema(
  {
    scheduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Schedule",
      default: null,
    },
    socialAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SocialAccount",
      required: true,
      index: true,
    },
    contentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Content",
      required: true,
    },
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
    },

    platform: {
      type: String,
      enum: ["facebook", "instagram", "linkedin"],
      required: true,
    },
    publishType: {
      type: String,
      enum: ["scheduled", "immediate"],
      default: "scheduled",
    },

    status: {
      type: String,
      enum: ["success", "failed", "retrying"],
      required: true,
      index: true,
    },
    externalPostId: { type: String, default: "" },
    externalPostUrl: { type: String, default: "" },

    errorMessage: { type: String, default: "" },
    // Meta Graph API error codes: "190" = expired token, "200" = permissions, etc.
    errorCode: { type: String, default: "" },

    attempt: { type: Number, default: 1, min: 1 },

    executedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

publishLogSchema.index({ userId: 1, createdAt: -1 });
publishLogSchema.index({ scheduleId: 1 });

module.exports = mongoose.model("PublishLog", publishLogSchema);
