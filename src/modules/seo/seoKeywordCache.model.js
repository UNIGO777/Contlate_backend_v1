const mongoose = require("mongoose");

const seoKeywordCacheSchema = new mongoose.Schema(
  {
    cacheKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ["category", "subcategory"],
      default: "category",
    },
    category: {
      type: String,
      required: true,
      trim: true,
    },
    subcategory: {
      type: String,
      trim: true,
      default: "",
    },
    city: {
      type: String,
      required: true,
      trim: true,
    },
    state: {
      type: String,
      trim: true,
      default: "",
    },
    locationName: {
      type: String,
      trim: true,
      default: "",
    },
    keywords: [
      {
        _id: false,
        keyword: { type: String, required: true },
        monthlyVolume: { type: Number, default: null },
        competition: { type: String, default: null },
        trendValue: { type: Number, default: null },
        isRising: { type: Boolean, default: null },
        source: {
          type: String,
          enum: ["google_trends", "template", null],
          default: null,
        },
      },
    ],
    lastRefreshed: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    premiumUserCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastUsedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

seoKeywordCacheSchema.index({ expiresAt: 1 });

const SeoKeywordCache = mongoose.model("SeoKeywordCache", seoKeywordCacheSchema);

module.exports = SeoKeywordCache;
