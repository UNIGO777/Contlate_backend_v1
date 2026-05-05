const mongoose = require("mongoose");

const usageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    dateKey: { type: String, required: true, trim: true, index: true },
    uploadsCount: { type: Number, default: 0, min: 0 },
    scheduledPostsCount: { type: Number, default: 0, min: 0 },
    publishedPostsCount: { type: Number, default: 0, min: 0 },
    aiPostersCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, versionKey: false }
);

usageSchema.index({ userId: 1, dateKey: 1 }, { unique: true });

const Usage = mongoose.model("Usage", usageSchema);

module.exports = Usage;
