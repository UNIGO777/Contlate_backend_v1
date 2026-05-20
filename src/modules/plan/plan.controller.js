const asyncHandler = require("../../core/asyncHandler");
const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const Business = require("../business/business.model");
const ContentPlan = require("../poster/contentPlan.model");
const BusinessOffers = require("./businessOffers.model");
const Schedule = require("../schedule/schedule.model");
const { SCHEDULE_STATUS } = require("../../constants/scheduleStatus");
const { generatePlanConcepts, buildDayDocuments } = require("../../services/planGeneration.service");
const { getQueues } = require("../../queues/queues");
const logger = require("../../core/logger");

// ── GET /plan/setup ──────────────────────────────────────────────────────────
// Returns existing BusinessOffers (if any) and the business's current service
// list so the frontend can pre-populate the form.
const getSetup = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const business = req.business;

  const existing = await BusinessOffers.findOne({ userId }).lean();

  return res.json(
    new ApiResponse(200, {
      offers: existing ?? null,
      businessServices: business.services ?? [],
    })
  );
});

// ── POST /plan/setup ─────────────────────────────────────────────────────────
// Saves / updates BusinessOffers and autoPostTime.
const saveSetup = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const businessId = req.business._id;
  const { businessType, products, services, autoPostTime } = req.body;

  if (!businessType || !["product", "service"].includes(businessType)) {
    throw new ApiError(400, "businessType must be 'product' or 'service'");
  }
  if (autoPostTime && !/^\d{2}:\d{2}$/.test(autoPostTime)) {
    throw new ApiError(400, "autoPostTime must be in HH:MM format (e.g. '12:00')");
  }

  const doc = await BusinessOffers.findOneAndUpdate(
    { userId },
    {
      userId,
      businessId,
      businessType,
      products: businessType === "product" ? (products ?? []) : [],
      services: businessType === "service" ? (services ?? []) : [],
      autoPostTime: autoPostTime ?? "12:00",
    },
    { upsert: true, new: true, runValidators: true }
  );

  return res.json(new ApiResponse(200, { offers: doc }, "Setup saved."));
});

// ── POST /plan/generate ──────────────────────────────────────────────────────
// Generates the full 28-day content plan using OpenAI.
// Creates a ContentPlan document and links it to the business.
const triggerGenerate = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const business = req.business;
  const businessId = business._id;

  // Ensure setup has been completed
  const offers = await BusinessOffers.findOne({ userId }).lean();
  if (!offers) {
    throw new ApiError(400, "Complete post-payment setup before generating a plan.");
  }

  // Cancel any existing active plan for this business
  await ContentPlan.updateMany(
    { businessId, status: { $in: ["generating", "active"] } },
    { $set: { status: "cancelled" } }
  );

  // Cycle starts today at midnight
  const cycleStartDate = new Date();
  cycleStartDate.setHours(0, 0, 0, 0);

  const cycleEndDate = new Date(cycleStartDate);
  cycleEndDate.setDate(cycleEndDate.getDate() + 28);

  // Generate 28 concepts via OpenAI
  logger.info("[planGeneration] Generating 28-day plan", { userId: String(userId) });
  let concepts;
  try {
    const country = business.addressDetails?.country || "";
    concepts = await generatePlanConcepts(business, offers, cycleStartDate, country);
  } catch (err) {
    logger.error("[planGeneration] AI generation failed", { error: err.message });
    throw new ApiError(500, "Failed to generate plan concepts. Please try again.");
  }

  // Build day documents with scheduling
  const autoPostTime = offers.autoPostTime || "12:00";
  const days = buildDayDocuments(concepts, cycleStartDate, autoPostTime);

  // Persist plan
  const plan = await ContentPlan.create({
    userId,
    businessId,
    planType: "premium",
    cycleStartDate,
    cycleEndDate,
    status: "active",
    days,
  });

  // Link plan to business
  await Business.updateOne({ _id: businessId }, { $set: { activeContentPlanId: plan._id } });

  // Mark Day 1 as generating and kick off the prompt chain
  await ContentPlan.updateOne(
    { _id: plan._id, "days.dayNumber": 1 },
    { $set: { "days.$.promptStatus": "generating", "days.$.planStatus": "generating" } }
  );

  const queues = getQueues();
  await queues.posterPrompt.add(
    `chain-prompt-day-1-${businessId}`,
    { contentPlanId: plan._id.toString(), dayNumber: 1 },
    { jobId: `prompt-${plan._id}-day1` }
  );

  logger.info("[planGeneration] Plan created", {
    userId: String(userId),
    planId: String(plan._id),
    dayCount: days.length,
  });

  return res.json(
    new ApiResponse(200, { planId: plan._id, status: "active", dayCount: days.length }, "28-day plan generated.")
  );
});

// ── GET /plan/active ─────────────────────────────────────────────────────────
// Returns the active plan's days mapped to the frontend PlanDay shape.
// Frontend uses this to populate `planDays` state for the timeline and modal.
const getActivePlan = asyncHandler(async (req, res) => {
  const business = req.business;

  const plan = await ContentPlan.findOne({
    businessId: business._id,
    status: { $in: ["active", "generating"] },
  })
    .sort({ cycleStartDate: -1 })
    .lean();

  if (!plan) {
    return res.json(new ApiResponse(200, null, "No active content plan."));
  }

  // Map each day to the frontend PlanDay shape
  const days = plan.days.map((d) => ({
    dayNumber: d.dayNumber,
    title: d.title || d.topic || `Day ${d.dayNumber}`,
    description: d.description || null,
    status: d.planStatus || "concept",
    queueToken: d.queueToken ?? null,
    promptText: d.prompt || null,
    imageUrl: d.imageUrl || null,
    caption: d.caption || null,
    scheduledPostAt: d.scheduledPostAt ? d.scheduledPostAt.toISOString() : null,
    declineDeadlineAt: d.declineDeadlineAt ? d.declineDeadlineAt.toISOString() : null,
    scheduledGenerationAt: d.scheduledGenerationAt ? d.scheduledGenerationAt.toISOString() : null,
  }));

  return res.json(
    new ApiResponse(200, {
      planId: plan._id,
      cycleStartDate: plan.cycleStartDate,
      cycleEndDate: plan.cycleEndDate,
      status: plan.status,
      days,
    })
  );
});

// ── POST /plan/days/:dayNumber/approve ───────────────────────────────────────
// Phase 6: User approves auto-post for a day.
const approveDay = asyncHandler(async (req, res) => {
  const dayNum = parseInt(req.params.dayNumber, 10);
  const business = req.business;

  const plan = await ContentPlan.findOne({
    businessId: business._id,
    status: { $in: ["active", "generating"] },
  }).sort({ cycleStartDate: -1 });

  if (!plan) throw new ApiError(404, "No active plan found.");

  const day = plan.days.find((d) => d.dayNumber === dayNum);
  if (!day) throw new ApiError(404, `Day ${dayNum} not found.`);
  if (day.planStatus === "posted") throw new ApiError(400, "This day has already been posted.");

  await ContentPlan.updateOne(
    { _id: plan._id, "days.dayNumber": dayNum },
    { $set: { "days.$.planStatus": "approved", "days.$.approvedAt": new Date() } }
  );

  return res.json(new ApiResponse(200, null, "Day approved."));
});

// ── POST /plan/days/:dayNumber/decline ───────────────────────────────────────
// Phase 6: User declines auto-post for a day.
const declineDay = asyncHandler(async (req, res) => {
  const dayNum = parseInt(req.params.dayNumber, 10);
  const business = req.business;

  const plan = await ContentPlan.findOne({
    businessId: business._id,
    status: { $in: ["active", "generating"] },
  }).sort({ cycleStartDate: -1 });

  if (!plan) throw new ApiError(404, "No active plan found.");

  const day = plan.days.find((d) => d.dayNumber === dayNum);
  if (!day) throw new ApiError(404, `Day ${dayNum} not found.`);
  if (day.planStatus === "posted") throw new ApiError(400, "This day has already been posted.");
  if (day.declineDeadlineAt && new Date() > new Date(day.declineDeadlineAt)) {
    throw new ApiError(400, "Decline deadline has passed for this day.");
  }

  await ContentPlan.updateOne(
    { _id: plan._id, "days.dayNumber": dayNum },
    { $set: { "days.$.planStatus": "declined", "days.$.declinedAt": new Date() } }
  );

  // Cancel any pending Schedule entry for this day so it doesn't auto-post
  if (day.contentId) {
    await Schedule.updateMany(
      { contentId: day.contentId, status: SCHEDULE_STATUS.PENDING },
      { $set: { status: SCHEDULE_STATUS.CANCELLED } }
    );
  }

  return res.json(new ApiResponse(200, null, "Day declined."));
});

// ── PATCH /plan/days/:dayNumber/caption ──────────────────────────────────────
// Phase 6: User edits the caption for a day.
const updateCaption = asyncHandler(async (req, res) => {
  const dayNum = parseInt(req.params.dayNumber, 10);
  const { caption } = req.body;
  const business = req.business;

  if (typeof caption !== "string") {
    throw new ApiError(400, "caption must be a string.");
  }
  if (caption.length > 2200) {
    throw new ApiError(400, "Caption exceeds 2200 character limit.");
  }

  const plan = await ContentPlan.findOne({
    businessId: business._id,
    status: { $in: ["active", "generating"] },
  }).sort({ cycleStartDate: -1 });

  if (!plan) throw new ApiError(404, "No active plan found.");

  const day = plan.days.find((d) => d.dayNumber === dayNum);
  if (!day) throw new ApiError(404, `Day ${dayNum} not found.`);
  if (day.declineDeadlineAt && new Date() > new Date(day.declineDeadlineAt)) {
    throw new ApiError(400, "Caption edit deadline has passed for this day.");
  }

  await ContentPlan.updateOne(
    { _id: plan._id, "days.dayNumber": dayNum },
    { $set: { "days.$.caption": caption.trim() } }
  );

  return res.json(new ApiResponse(200, null, "Caption updated."));
});

module.exports = { getSetup, saveSetup, triggerGenerate, getActivePlan, approveDay, declineDay, updateCaption };
