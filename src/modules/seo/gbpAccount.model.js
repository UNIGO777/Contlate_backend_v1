const mongoose = require("mongoose");

const gbpAccountSchema = new mongoose.Schema(
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
      unique: true,
    },
    // IMPORTANT: tokens MUST be encrypted before storage via gbpOAuthService.
    // Never store plain-text tokens. See plan.md Phase 3.1 for encryption details.
    accessToken: {
      type: String,
      required: true,
    },
    refreshToken: {
      type: String,
      required: true,
    },
    tokenExpiry: {
      type: Date,
      required: true,
    },
    scopes: {
      type: [String],
      default: [],
    },
    gbpAccountId: {
      type: String,
      default: "",
    },
    gbpAccountName: {
      type: String,
      default: "",
    },
    gbpLocationId: {
      type: String,
      default: "",
    },
    gbpLocationName: {
      type: String,
      default: "",
    },
    connectedAt: {
      type: Date,
      default: Date.now,
    },
    lastSyncedAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["connected", "expired", "revoked", "pending_locations"],
      default: "connected",
    },
    encryptionVersion: {
      type: Number,
      default: 1,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

const GbpAccount = mongoose.model("GbpAccount", gbpAccountSchema);

module.exports = GbpAccount;
