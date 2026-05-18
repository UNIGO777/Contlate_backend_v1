const mongoose = require("mongoose");
const { CONTENT_STATUS } = require("../../constants/contentStatus");

const contentSchema = new mongoose.Schema(
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
    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },
    caption: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: Object.values(CONTENT_STATUS),
      default: CONTENT_STATUS.READY,
      index: true,
    },
    sourceType: {
      type: String,
      trim: true,
      default: "manual",
    },
    tags: {
      type: [String],
      default: [],
    },
    generationCost: {
      gptCost: { type: Number, default: 0 },
      imageCost: { type: Number, default: 0 },
      totalCost: { type: Number, default: 0 },
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      imageSize: { type: String, default: "" },
      imageQuality: { type: String, default: "" },
    },
    socialPostUrls: [
      {
        platform: { type: String },
        accountId: { type: String },
        postUrl: { type: String },
        postId: { type: String },
        postedAt: { type: Date },
      },
    ],
    localImagePath: { type: String, default: "" },
    localImageDeleted: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

contentSchema.index({ userId: 1, createdAt: -1 });

const Content = mongoose.model("Content", contentSchema);

module.exports = Content;
