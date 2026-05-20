const mongoose = require("mongoose");

const keywordSchema = new mongoose.Schema(
  {
    keyword: { type: String, required: true, trim: true },
    monthlyVolumeRange: { type: String, default: "" },
    originalRankRange: { type: String, default: "" },
    month1RankRange: { type: String, default: null },
    month2RankRange: { type: String, default: null },
    month3RankRange: { type: String, default: null },
    targetRankRange: { type: String, default: "" },
    estimatedClientIncrease: { type: String, default: "" },
    isCurrentlyUsed: { type: Boolean, default: false },
    priority: {
      type: String,
      enum: ["high", "medium", "low"],
      default: "medium",
    },
    category: { type: String, default: "" },
    workOnIt: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["active", "completed"],
      default: "active",
    },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const completedKeywordSchema = new mongoose.Schema(
  {
    keyword: { type: String, required: true },
    monthlyVolumeRange: { type: String, default: "" },
    originalRankRange: { type: String, default: "" },
    finalRankRange: { type: String, default: "" },
    estimatedClientIncrease: { type: String, default: "" },
    cycleNumber: { type: Number, default: 1 },
    completedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const aiSeoSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      unique: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    overallScore: { type: Number, default: 0, min: 0, max: 100 },
    topOpportunity: { type: String, default: "" },
    summary: { type: String, default: "" },

    cycleNumber: { type: Number, default: 1 },
    cycleStartedAt: { type: Date, default: null },
    currentMonth: { type: Number, default: 0, min: 0, max: 3 },
    lastRefreshedAt: { type: Date, default: null },

    keywords: [keywordSchema],
    completedKeywords: [completedKeywordSchema],

    status: {
      type: String,
      enum: ["generating", "ready", "error"],
      default: "generating",
    },
    lastError: { type: String, default: "" },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

const AiSeo = mongoose.model("AiSeo", aiSeoSchema);

module.exports = AiSeo;
