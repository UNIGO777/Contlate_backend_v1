const mongoose = require("mongoose");
const { SCHEDULE_STATUS } = require("../../constants/scheduleStatus");

const scheduleSchema = new mongoose.Schema(
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
    contentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Content",
      required: true,
      index: true,
    },
    socialAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SocialAccount",
      required: true,
      index: true,
    },
    scheduledAt: {
      type: Date,
      required: true,
      index: true,
    },
    timezone: {
      type: String,
      trim: true,
      default: "UTC",
    },
    status: {
      type: String,
      enum: Object.values(SCHEDULE_STATUS),
      default: SCHEDULE_STATUS.PENDING,
      index: true,
    },
    publishAttempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastError: {
      type: String,
      default: "",
    },
    lockedAt: {
      type: Date,
      default: null,
    },
    publishedAt: {
      type: Date,
      default: null,
    },
    externalPostId: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Index that the publisher job hits to find due work fast.
scheduleSchema.index({ status: 1, scheduledAt: 1 });
scheduleSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("Schedule", scheduleSchema);
