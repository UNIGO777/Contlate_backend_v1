const mongoose = require("mongoose");
const { PLANS } = require("../../constants/plans");
const { ROLES } = require("../../constants/roles");

const refreshTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true },
    device: { type: String, default: null, trim: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { _id: true }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, default: null },
    googleId: { type: String, default: null, sparse: true, index: true },
    metaId: { type: String, default: null, sparse: true, index: true },
    phone: { type: String, trim: true, default: null },
    avatarUrl: { type: String, trim: true, default: null },
    role: {
      type: String,
      enum: Object.values(ROLES),
      default: ROLES.USER,
    },
    plan: {
      type: String,
      enum: Object.values(PLANS),
      default: PLANS.BASIC,
    },
    isEmailVerified: { type: Boolean, default: false },
    trialStartAt: { type: Date, default: Date.now },
    trialEndsAt: {
      type: Date,
      default: () => {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        return d;
      },
    },
    loginFailures: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    refreshTokens: { type: [refreshTokenSchema], default: [] },
    expoPushTokens: {
      type: [
        {
          token: { type: String, required: true },
          device: { type: String, default: null },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    deletedAt: { type: Date, default: null, index: true },
    suspendedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

// email already has unique: true in the schema — no duplicate index needed

const User = mongoose.model("User", userSchema);

module.exports = User;
