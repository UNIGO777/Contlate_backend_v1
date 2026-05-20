const mongoose = require("mongoose");

const offerSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: "" },
    discount: { type: Number, min: 0, max: 100, default: null },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    price: { type: Number, min: 0, default: null },
    offer: { type: offerSchema, default: null },
  },
  { _id: true }
);

const serviceOfferSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    offer: { type: offerSchema, default: null },
  },
  { _id: true }
);

const businessOffersSchema = new mongoose.Schema(
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
    businessType: {
      type: String,
      enum: ["product", "service"],
      required: true,
    },
    // Product businesses: list of products with offers
    products: { type: [productSchema], default: [] },
    // Service businesses: services with offers
    // (service names mirror Business.services but can diverge after editing)
    services: { type: [serviceOfferSchema], default: [] },
    // User's chosen auto-post time (HH:MM, 24-hour)
    autoPostTime: { type: String, default: "12:00" },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// One BusinessOffers document per user — upsert on save
businessOffersSchema.index({ userId: 1 }, { unique: true });

const BusinessOffers = mongoose.model("BusinessOffers", businessOffersSchema);

module.exports = BusinessOffers;
