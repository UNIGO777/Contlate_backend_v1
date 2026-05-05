const mongoose = require("mongoose");
const { PLANS } = require("../../constants/plans");
const { SUBSCRIPTION_STATUS } = require("../../constants/subscriptionStatus");

const subscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    plan: {
      type: String,
      enum: Object.values(PLANS),
      required: true,
      default: PLANS.BASIC,
    },
    status: {
      type: String,
      enum: Object.values(SUBSCRIPTION_STATUS),
      required: true,
      default: SUBSCRIPTION_STATUS.TRIALING,
    },
    billingCycle: {
      type: String,
      enum: ["monthly", "yearly", "28d"],
      default: "monthly",
    },
    paymentProvider: {
      type: String,
      trim: true,
      default: "manual",
    },
    providerCustomerId: {
      type: String,
      trim: true,
      default: "",
    },
    providerSubscriptionId: {
      type: String,
      trim: true,
      default: "",
    },
    startsAt: {
      type: Date,
      default: Date.now,
    },
    endsAt: {
      type: Date,
      default: null,
    },
    trialEndsAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

subscriptionSchema.index({ userId: 1 }, { unique: true });

const Subscription = mongoose.model("Subscription", subscriptionSchema);

module.exports = Subscription;
