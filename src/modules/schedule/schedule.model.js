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
    // What the user actually selected — displayed in UI (never adjusted)
    userPreferredTime: {
      type: Date,
      default: null,
    },
    // Actual execution time = userPreferredTime + stagger offset (stored in scheduledAt)
    staggerOffsetMinutes: {
      type: Number,
      default: 0,
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
    reminderSent: {
      type: Boolean,
      default: false,
    },
    // When retrying stops. Set on the first failure to the end of the client's
    // calendar day that the post was originally due on, so a post retries all
    // evening but never goes out stale the next morning — a day-old "today's
    // offer" is worse for the client than no post at all. Past this, the post
    // is abandoned and the plan starts a fresh poster for the new day.
    retryDeadlineAt: {
      type: Date,
      default: null,
      index: true,
    },
    // Who put this row here. The autopilot master switch must silence the
    // plan's own auto-scheduled posts without also silencing a post the user
    // scheduled by hand — those are an explicit instruction, not automation.
    source: {
      type: String,
      enum: ["manual", "autopilot"],
      default: "manual",
      index: true,
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
