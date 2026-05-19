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
    posterSettings: {
      modelImagePath: { type: String, default: "" },
      modelImageUrl: { type: String, default: "" },
      useModelImage: { type: Boolean, default: false },
      activeTheme: {
        name: { type: String, trim: true, default: "" },
        colors: { type: [String], default: [] },
        vibe: { type: String, trim: true, default: "" },
      },
      defaultSize: { type: String, default: "4:5" },
      defaultQuality: { type: String, default: "auto" },
      defaultLanguage: { type: String, default: "english" },
      defaultStyle: { type: String, default: "ai_decide" },
    },
    welcomePosters: {
      introDone: { type: Boolean, default: false },
      introContentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Content",
        default: null,
      },
      aboutUsDone: { type: Boolean, default: false },
      aboutUsContentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Content",
        default: null,
      },
      aboutUsScheduledAt: { type: Date, default: null },
    },
    activeContentPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ContentPlan",
      default: null,
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
    seo: {
      locationName: { type: String, trim: true, default: "" },
      cacheKey: { type: String, trim: true, default: "" },
      rankDataAvailable: { type: Boolean, default: false },
      keywordsFromCache: { type: Boolean, default: false },
      keywords: [
        {
          _id: false,
          keyword: { type: String },
          monthlyVolume: { type: Number, default: null },
          competition: { type: String, default: null },
          mapsRank: { type: Number, default: null },
          topBusiness: { type: String, default: null },
          trendValue: { type: Number, default: null },
          isRising: { type: Boolean, default: null },
          source: {
            type: String,
            enum: ["google_trends", "template", null],
            default: null,
          },
          group: { type: String, default: null },
          groupType: {
            type: String,
            enum: ["category", "subcategory", null],
            default: null,
          },
          updatedAt: { type: Date, default: null },
        },
      ],
      lastKeywordRefresh: { type: Date, default: null },
      lastRankRefresh: { type: Date, default: null },
      seoRefreshStartedAt: { type: Date, default: null },
      status: {
        type: String,
        enum: ["pending", "keywords_ready", "ready", "error"],
        default: "pending",
      },
      lastError: { type: String, default: "" },
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

// userId already has unique: true in the schema — no duplicate index needed

businessSchema.index({ "seo.cacheKey": 1 });
businessSchema.index({ "seo.lastRankRefresh": 1 });

const Business = mongoose.model("Business", businessSchema);

module.exports = Business;
