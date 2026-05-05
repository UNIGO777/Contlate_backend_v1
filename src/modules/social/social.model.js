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
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

socialAccountSchema.index({ userId: 1, platform: 1, accountId: 1 }, { unique: true });

const SocialAccount = mongoose.model("SocialAccount", socialAccountSchema);

module.exports = SocialAccount;
