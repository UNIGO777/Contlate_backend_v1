const mongoose = require("mongoose");
const { SOCIAL_PLATFORMS } = require("../../constants/socialPlatforms");
const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");

const socialAccountSchema = new mongoose.Schema(
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
    platform: {
      type: String,
      enum: Object.values(SOCIAL_PLATFORMS),
      required: true,
      index: true,
    },
    accountName: {
      type: String,
      required: true,
      trim: true,
    },
    accountId: {
      type: String,
      required: true,
      trim: true,
    },
    accessToken: {
      type: String,
      required: true,
      trim: true,
    },
    refreshToken: {
      type: String,
      trim: true,
      default: "",
    },
    tokenExpiresAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: Object.values(SOCIAL_ACCOUNT_STATUS),
      default: SOCIAL_ACCOUNT_STATUS.CONNECTED,
      index: true,
    },
    lastSyncedAt: {
      type: Date,
      default: Date.now,
    },

    // --- Page/Account metadata ---
    pageId: { type: String, default: "" },
    profilePictureUrl: { type: String, default: "" },

    // --- Token management ---
    userAccessToken: { type: String, default: "" },
    tokenVersion: { type: Number, default: 0 },
    lastTokenRefreshedAt: { type: Date, default: null },

    // --- Capabilities ---
    capabilities: {
      canPublishPhotos: { type: Boolean, default: true },
      canPublishVideos: { type: Boolean, default: false },
      canPublishReels: { type: Boolean, default: false },
      canPublishStories: { type: Boolean, default: false },
    },

    // --- Onboarding state ---
    setupIssues: [
      {
        type: String,
        enum: [
          "no_pages",
          "no_instagram",
          "personal_instagram",
          "missing_permissions",
        ],
      },
    ],

    // --- Health tracking ---
    healthStatus: {
      type: String,
      enum: ["healthy", "warning", "critical"],
      default: "healthy",
      index: true,
    },

    // --- Disconnect reason (for reconnect UI) ---
    disconnectReason: {
      type: String,
      enum: [
        "user_action",
        "token_expired",
        "permissions_revoked",
        "page_deleted",
        "meta_deauth",
        "user_deauthorized",
        "page_deauthorized",
        "data_deletion",
        "data_deletion_request",
      ],
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

socialAccountSchema.index({ userId: 1, platform: 1, accountId: 1 }, { unique: true });

const SocialAccount = mongoose.model("SocialAccount", socialAccountSchema);

module.exports = SocialAccount;
