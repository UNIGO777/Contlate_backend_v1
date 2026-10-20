const mongoose = require("mongoose");

/**
 * An operational problem that needs a human — specifically us, not the client.
 *
 * A client-fixable failure (expired token, revoked permissions) emails the
 * client and resolves itself when they reconnect. A failure caused by our own
 * code or data has nobody watching it: the post just sits failed. These rows
 * are that missing watcher, and they keep emailing until someone resolves
 * them.
 *
 * Keyed so a repeatedly failing schedule raises one alert, not one per retry.
 */
const adminAlertSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    type: {
      type: String,
      required: true,
      enum: ["publish_permanent_failure", "poster_generation_failure", "chain_stalled"],
      index: true,
    },
    status: {
      type: String,
      enum: ["open", "resolved"],
      default: "open",
      index: true,
    },
    title: { type: String, required: true, trim: true },
    message: { type: String, default: "", trim: true },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", default: null },
    scheduleId: { type: mongoose.Schema.Types.ObjectId, ref: "Schedule", default: null },

    // How many times this has recurred since the alert was opened.
    occurrences: { type: Number, default: 1 },
    // Drives the hourly cadence — an alert is re-sent only once an hour.
    lastNotifiedAt: { type: Date, default: null },
    notifyCount: { type: Number, default: 0 },

    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: "" },

    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, versionKey: false }
);

adminAlertSchema.index({ status: 1, lastNotifiedAt: 1 });

module.exports = mongoose.model("AdminAlert", adminAlertSchema);
