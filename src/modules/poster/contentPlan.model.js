const mongoose = require("mongoose");

const daySchema = new mongoose.Schema(
  {
    dayNumber: { type: Number, required: true, min: 1 },
    date: { type: Date, required: true },
    topic: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },
    contentType: { type: String, trim: true, default: "" },

    // Prompt state
    promptStatus: {
      type: String,
      enum: ["pending", "generating", "ready", "edited", "failed"],
      default: "pending",
    },
    prompt: { type: String, default: "" },
    promptText: {
      headline: { type: String, default: "" },
      tagline: { type: String, default: "" },
      offer: { type: String, default: "" },
      cta: { type: String, default: "" },
    },
    promptGeneratedAt: { type: Date, default: null },
    promptEditedByUser: { type: Boolean, default: false },

    // Image state
    imageStatus: {
      type: String,
      enum: ["pending", "generating", "ready", "failed"],
      default: "pending",
    },
    localImagePath: { type: String, default: "" },
    imageGeneratedAt: { type: Date, default: null },

    // Content record link
    contentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Content",
      default: null,
    },

    // After posting
    posted: { type: Boolean, default: false },
    postedAt: { type: Date, default: null },
    socialPostUrls: [
      {
        platform: { type: String },
        postUrl: { type: String },
        postId: { type: String },
      },
    ],

    // Error tracking
    lastError: { type: String, default: "" },
    retryCount: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const contentPlanSchema = new mongoose.Schema(
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
    planType: {
      type: String,
      enum: ["free", "premium"],
      required: true,
    },
    cycleStartDate: { type: Date, required: true },
    cycleEndDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ["generating", "active", "completed", "cancelled"],
      default: "generating",
      index: true,
    },

    days: [daySchema],

    // Generation progress tracking
    promptsGeneratedUpTo: { type: Number, default: 0 },
    imagesGeneratedUpTo: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

contentPlanSchema.index({ businessId: 1, cycleStartDate: -1 });
contentPlanSchema.index({ "days.date": 1, "days.imageStatus": 1 });

const ContentPlan = mongoose.model("ContentPlan", contentPlanSchema);

module.exports = ContentPlan;
