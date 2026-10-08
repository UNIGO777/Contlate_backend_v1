const mongoose = require("mongoose");

/**
 * Cached Google Business Profile performance metrics.
 *
 * The GBP Performance API has a tight per-project daily quota and these are
 * daily-granularity metrics that only change once a day, so we store one
 * document per business and serve it until `expiresAt` passes. Nothing in the
 * app ever calls Google directly on render.
 */
const gbpDailyPointSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    views: { type: Number, default: 0 },
    calls: { type: Number, default: 0 },
    directions: { type: Number, default: 0 },
    websiteClicks: { type: Number, default: 0 },
  },
  { _id: false }
);

const gbpTotalsSchema = new mongoose.Schema(
  {
    views: { type: Number, default: 0 },
    viewsMaps: { type: Number, default: 0 },
    viewsSearch: { type: Number, default: 0 },
    calls: { type: Number, default: 0 },
    directions: { type: Number, default: 0 },
    websiteClicks: { type: Number, default: 0 },
  },
  { _id: false }
);

const gbpInsightsSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      unique: true,
      index: true,
    },
    gbpLocationId: { type: String, default: "" },

    // Window the totals cover (inclusive start, exclusive end).
    rangeStart: { type: Date, required: true },
    rangeEnd: { type: Date, required: true },

    totals: { type: gbpTotalsSchema, default: () => ({}) },
    // Same-length window immediately before `rangeStart`, for the deltas.
    previousTotals: { type: gbpTotalsSchema, default: () => ({}) },
    // Percentage change vs the previous window; null when there is no baseline.
    deltaPct: {
      views: { type: Number, default: null },
      calls: { type: Number, default: null },
      directions: { type: Number, default: null },
    },

    daily: { type: [gbpDailyPointSchema], default: [] },

    fetchedAt: { type: Date, default: Date.now },
    // Served from cache until this passes; see GBP_INSIGHTS_TTL_HOURS.
    expiresAt: { type: Date, required: true },
    // Set when the last refresh failed, so we can surface staleness instead of
    // pretending the numbers are fresh.
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

const GbpInsights = mongoose.model("GbpInsights", gbpInsightsSchema);

module.exports = GbpInsights;
