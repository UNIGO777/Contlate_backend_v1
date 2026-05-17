const mongoose = require("mongoose");

const businessSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
      unique: true,
    },
    businessName: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      trim: true,
      default: "",
    },
    subcategories: {
      type: [String],
      default: [],
    },
    services: {
      type: [String],
      default: [],
    },
    description: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1500,
    },
    website: {
      type: String,
      trim: true,
      default: "",
    },
    contactEmail: {
      type: String,
      trim: true,
      default: "",
    },
    hasContactEmail: {
      type: Boolean,
      default: false,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      type: String,
      trim: true,
      default: "",
    },
    addressDetails: {
      line1: { type: String, trim: true, default: "" },
      line2: { type: String, trim: true, default: "" },
      landmark: { type: String, trim: true, default: "" },
      city: { type: String, trim: true, default: "" },
      state: { type: String, trim: true, default: "" },
      country: { type: String, trim: true, default: "" },
      pincode: { type: String, trim: true, default: "" },
    },
    brandAssets: {
      logoUrl: {
        type: String,
        trim: true,
      },
      primaryColor: {
        type: String,
        trim: true,
      },
      secondaryColor: {
        type: String,
        trim: true,
      },
      theme: {
        name: { type: String, trim: true, default: "" },
        colors: { type: [String], default: [] },
        vibe: { type: String, trim: true, default: "" },
      },
    },
    savedThemes: {
      type: [
        {
          name: { type: String, trim: true, default: "" },
          colors: { type: [String], default: [] },
          vibe: { type: String, trim: true, default: "" },
        },
      ],
      default: [],
    },
    timezone: {
      type: String,
      trim: true,
      default: "",
    },
    isCompleted: {
      type: Boolean,
      default: false,
    },
    onboardingStep: {
      type: Number,
      default: 0,
      min: 0,
    },
    autopilot: {
      enabled: {
        type: Boolean,
        default: true,
      },
      approvalRequired: {
        type: Boolean,
        default: false,
      },
    },
    google: {
      placeId: { type: String, trim: true, default: "" },
      displayName: { type: String, trim: true, default: "" },
      formattedAddress: { type: String, trim: true, default: "" },
      website: { type: String, trim: true, default: "" },
      internationalPhoneNumber: { type: String, trim: true, default: "" },
      rating: { type: Number, default: null },
      userRatingCount: { type: Number, default: null },
      googleMapsUri: { type: String, trim: true, default: "" },
      businessStatus: { type: String, trim: true, default: "" },
      types: { type: [String], default: [] },
      primaryType: { type: String, trim: true, default: "" },
      primaryTypeDisplayName: { type: String, trim: true, default: "" },
      editorialSummary: { type: String, trim: true, default: "" },
      regularOpeningHours: { type: mongoose.Schema.Types.Mixed, default: null },
      location: {
        lat: { type: Number, default: null },
        lng: { type: Number, default: null },
      },
      fetchedAt: { type: Date, default: null },
      lastError: { type: String, default: "" },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

businessSchema.index({ userId: 1 }, { unique: true });

const Business = mongoose.model("Business", businessSchema);

module.exports = Business;
