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
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

contentSchema.index({ userId: 1, createdAt: -1 });

const Content = mongoose.model("Content", contentSchema);

module.exports = Content;
