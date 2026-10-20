const mongoose = require("mongoose");

const daySchema = new mongoose.Schema(
  {
    dayNumber: { type: Number, required: true, min: 1 },
    date: { type: Date, required: true },
    topic: { type: String, trim: true, default: "" },      // legacy — same as title
    title: { type: String, trim: true, default: "" },      // display title (e.g. "Summer Sale")
    description: { type: String, trim: true, default: "" },
    contentType: { type: String, trim: true, default: "" },

    // ── Phase 4: combined frontend status ──────────────────────────────────
    // concept → prompt_ready → in_queue → generating → ready → approved/declined → posted
    // "skipped" is the other terminal state: the post kept failing and its day
    // ran out, so it was abandoned rather than published late. Stale content
    // ("today's offer", three days on) is worse for the client than no post,
    // and the chain starts a fresh poster for the new day instead.
    planStatus: {
      type: String,
      enum: ["concept", "prompt_ready", "in_queue", "generating", "ready", "approved", "declined", "posted", "skipped"],
      default: "concept",
    },

    // Prompt state
    promptStatus: {
      type: String,
      enum: ["pending", "generating", "ready", "edited", "failed"],
      default: "pending",
    },
    prompt: { type: String, default: "" },
    promptText: {
      headline: { type: String, default: "" },
      tagline: { type: String, default: "" },
      offer: { type: String, default: "" },
      cta: { type: String, default: "" },
    },
    promptGeneratedAt: { type: Date, default: null },
    promptEditedByUser: { type: Boolean, default: false },

    // Image state
    imageStatus: {
      type: String,
      enum: ["pending", "generating", "ready", "failed"],
      default: "pending",
    },
    localImagePath: { type: String, default: "" },
    imageUrl: { type: String, default: "" },               // public URL (Cloudinary / CDN)
    imageGeneratedAt: { type: Date, default: null },

    // Caption
    caption: { type: String, default: "" },

    // ── Phase 4: scheduling ────────────────────────────────────────────────
    scheduledGenerationAt: { type: Date, default: null },  // 12 AM on generation day
    scheduledPostAt: { type: Date, default: null },        // user's chosen time, day after generation
    declineDeadlineAt: { type: Date, default: null },      // 2 hours before scheduledPostAt

    // ── Phase 5: Bull queue ────────────────────────────────────────────────
    queueToken: { type: Number, default: null },
    // When the chain queued this day's prompt job. There is a gap between
    // queueing and the worker flipping the day to "generating", and during it
    // the day still reads as "concept" — long enough for the hourly stall
    // check to decide the plan is stuck and queue the very same day again.
    // This marks the day as spoken for until the worker takes over.
    chainQueuedAt: { type: Date, default: null },           // position in Bull queue

    // ── Phase 6: approve / decline ────────────────────────────────────────
    approvedAt: { type: Date, default: null },
    declinedAt: { type: Date, default: null },

    // Content record link
    contentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Content",
      default: null,
    },

    // After posting
    posted: { type: Boolean, default: false },
    postedAt: { type: Date, default: null },
    socialPostUrls: [
      {
        platform: { type: String },
        postUrl: { type: String },
        postId: { type: String },
        // Platform's copy of the image, shown once the local poster is gone.
        mediaUrl: { type: String },
        postedAt: { type: Date },
      },
    ],

    // Error tracking
    lastError: { type: String, default: "" },
    retryCount: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const contentPlanSchema = new mongoose.Schema(
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
    planType: {
      type: String,
      enum: ["free", "premium"],
      required: true,
    },
    cycleStartDate: { type: Date, required: true },
    cycleEndDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ["generating", "active", "completed", "cancelled"],
      default: "generating",
      index: true,
    },

    days: [daySchema],

    // Generation progress tracking
    promptsGeneratedUpTo: { type: Number, default: 0 },
    imagesGeneratedUpTo: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

contentPlanSchema.index({ businessId: 1, cycleStartDate: -1 });
contentPlanSchema.index({ "days.date": 1, "days.imageStatus": 1 });

const ContentPlan = mongoose.model("ContentPlan", contentPlanSchema);

module.exports = ContentPlan;
