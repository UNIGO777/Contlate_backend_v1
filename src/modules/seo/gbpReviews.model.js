const mongoose = require("mongoose");

/**
 * Cached Google Business Profile reviews.
 *
 * Reviews come from the legacy My Business v4 API, which is quota-limited and
 * allowlisted per project, so we keep a copy per business and serve that.
 * Nothing in the app calls Google on render.
 */
const gbpReviewSchema = new mongoose.Schema(
  {
    reviewId: { type: String, required: true },
    authorName: { type: String, default: "" },
    authorPhotoUrl: { type: String, default: "" },
    // v4 returns an enum ("FIVE"); stored as 1-5 so the UI can just render stars.
    starRating: { type: Number, default: 0 },
    comment: { type: String, default: "" },
    createTime: { type: Date, default: null },
    updateTime: { type: Date, default: null },
    // Present once the owner has replied — drives the "needs a reply" filter.
    replyComment: { type: String, default: null },
    replyUpdateTime: { type: Date, default: null },
  },
  { _id: false }
);

const gbpReviewsSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      unique: true,
      index: true,
    },
    gbpLocationId: { type: String, default: "" },

    reviews: { type: [gbpReviewSchema], default: [] },
    averageRating: { type: Number, default: 0 },
    totalReviewCount: { type: Number, default: 0 },
    unansweredCount: { type: Number, default: 0 },

    fetchedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

const GbpReviews = mongoose.model("GbpReviews", gbpReviewsSchema);

module.exports = GbpReviews;
