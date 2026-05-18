const fs = require("fs/promises");
const path = require("path");
const asyncHandler = require("../../core/asyncHandler");
const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const Business = require("../business/business.model");
const ContentPlan = require("./contentPlan.model");
const env = require("../../config/env");
const { getQueues } = require("../../queues/queues");

// ── GET /poster/settings ──
const getSettings = asyncHandler(async (req, res) => {
  const business = req.business;

  return res.json(
    new ApiResponse(200, {
      posterSettings: business.posterSettings || {},
      savedThemes: business.savedThemes || [],
      activeTheme:
        business.posterSettings?.activeTheme?.colors?.length > 0
          ? business.posterSettings.activeTheme
          : business.brandAssets?.theme || null,
    })
  );
});

// ── PATCH /poster/settings ──
const updateSettings = asyncHandler(async (req, res) => {
  const data = req.validated;
  const business = req.business;
  const update = {};

  if (data.activeTheme) update["posterSettings.activeTheme"] = data.activeTheme;
  if (data.defaultSize) update["posterSettings.defaultSize"] = data.defaultSize;
  if (data.defaultQuality) update["posterSettings.defaultQuality"] = data.defaultQuality;
  if (data.defaultLanguage) update["posterSettings.defaultLanguage"] = data.defaultLanguage;
  if (data.defaultStyle) update["posterSettings.defaultStyle"] = data.defaultStyle;
  if (data.useModelImage !== undefined) update["posterSettings.useModelImage"] = data.useModelImage;

  await Business.updateOne({ _id: business._id }, { $set: update });

  const updated = await Business.findById(business._id).lean();
  return res.json(
    new ApiResponse(200, { posterSettings: updated.posterSettings }, "Settings updated.")
  );
});

// ── POST /poster/model-image ──
const uploadModelImage = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, "No image file provided.", { code: ERROR_CODES.VALIDATION_FAILED });
  }

  const business = req.business;
  const dir = path.resolve(env.storageLocalDir, "model-images", String(business._id));
  await fs.mkdir(dir, { recursive: true });

  // Delete old file if exists
  if (business.posterSettings?.modelImagePath) {
    await fs.unlink(business.posterSettings.modelImagePath).catch(() => {});
  }

  const ext = req.file.mimetype === "image/png" ? "png" : req.file.mimetype === "image/webp" ? "webp" : "jpg";
  const filename = `model_${Date.now()}.${ext}`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, req.file.buffer);

  const publicUrl = `${env.storagePublicBaseUrl}/files/model-images/${business._id}/${filename}`;

  await Business.updateOne(
    { _id: business._id },
    {
      $set: {
        "posterSettings.modelImagePath": filePath,
        "posterSettings.modelImageUrl": publicUrl,
        "posterSettings.useModelImage": true,
      },
    }
  );

  return res.json(
    new ApiResponse(200, { modelImageUrl: publicUrl, modelImagePath: filePath }, "Model image uploaded.")
  );
});

// ── DELETE /poster/model-image ──
const deleteModelImage = asyncHandler(async (req, res) => {
  const business = req.business;

  if (business.posterSettings?.modelImagePath) {
    await fs.unlink(business.posterSettings.modelImagePath).catch(() => {});
  }

  await Business.updateOne(
    { _id: business._id },
    {
      $set: {
        "posterSettings.modelImagePath": "",
        "posterSettings.modelImageUrl": "",
        "posterSettings.useModelImage": false,
      },
    }
  );

  return res.json(new ApiResponse(200, null, "Model image removed."));
});

// ── GET /poster/plan/active ──
const getActivePlan = asyncHandler(async (req, res) => {
  const business = req.business;

  const plan = await ContentPlan.findOne({
    businessId: business._id,
    status: { $in: ["generating", "active"] },
  })
    .sort({ cycleStartDate: -1 })
    .lean();

  if (!plan) {
    return res.json(new ApiResponse(200, null, "No active content plan."));
  }

  return res.json(new ApiResponse(200, plan));
});

// ── PATCH /poster/plan/:planId/day/:dayNumber ──
const editDay = asyncHandler(async (req, res) => {
  const { planId, dayNumber } = req.params;
  const data = req.validated;
  const dayNum = parseInt(dayNumber, 10);

  const plan = await ContentPlan.findOne({
    _id: planId,
    userId: req.user.id,
  });
  if (!plan) throw new ApiError(404, "Content plan not found.");

  const day = plan.days.find((d) => d.dayNumber === dayNum);
  if (!day) throw new ApiError(404, `Day ${dayNum} not found.`);

  // Can only edit if prompt hasn't been generated yet
  if (day.promptStatus !== "pending" && day.promptStatus !== "failed") {
    throw new ApiError(400, "Cannot edit day — prompt has already been generated. Edit the prompt instead.");
  }

  const update = {};
  if (data.topic !== undefined) update[`days.$.topic`] = data.topic;
  if (data.description !== undefined) update[`days.$.description`] = data.description;

  await ContentPlan.updateOne(
    { _id: planId, "days.dayNumber": dayNum },
    { $set: update }
  );

  return res.json(new ApiResponse(200, null, "Day updated."));
});

// ── PATCH /poster/plan/:planId/day/:dayNumber/prompt ──
const editDayPrompt = asyncHandler(async (req, res) => {
  const { planId, dayNumber } = req.params;
  const data = req.validated;
  const dayNum = parseInt(dayNumber, 10);

  const plan = await ContentPlan.findOne({
    _id: planId,
    userId: req.user.id,
  });
  if (!plan) throw new ApiError(404, "Content plan not found.");

  const day = plan.days.find((d) => d.dayNumber === dayNum);
  if (!day) throw new ApiError(404, `Day ${dayNum} not found.`);

  // Can only edit if image hasn't been generated yet
  if (day.imageStatus === "ready" || day.imageStatus === "generating") {
    throw new ApiError(400, "Cannot edit prompt — image has already been generated.");
  }

  const update = { "days.$.promptEditedByUser": true, "days.$.promptStatus": "edited" };
  if (data.headline !== undefined) update["days.$.promptText.headline"] = data.headline;
  if (data.tagline !== undefined) update["days.$.promptText.tagline"] = data.tagline;
  if (data.offer !== undefined) update["days.$.promptText.offer"] = data.offer;
  if (data.cta !== undefined) update["days.$.promptText.cta"] = data.cta;
  if (data.fullPrompt !== undefined) update["days.$.prompt"] = data.fullPrompt;

  await ContentPlan.updateOne(
    { _id: planId, "days.dayNumber": dayNum },
    { $set: update }
  );

  return res.json(new ApiResponse(200, null, "Prompt updated."));
});

// ── POST /poster/plan/:planId/day/:dayNumber/regenerate-prompt ──
const regeneratePrompt = asyncHandler(async (req, res) => {
  const { planId, dayNumber } = req.params;
  const dayNum = parseInt(dayNumber, 10);

  const plan = await ContentPlan.findOne({
    _id: planId,
    userId: req.user.id,
  });
  if (!plan) throw new ApiError(404, "Content plan not found.");

  const day = plan.days.find((d) => d.dayNumber === dayNum);
  if (!day) throw new ApiError(404, `Day ${dayNum} not found.`);

  if (day.imageStatus === "ready" || day.imageStatus === "generating") {
    throw new ApiError(400, "Cannot regenerate prompt — image has already been generated.");
  }

  // Reset prompt status and queue regeneration
  await ContentPlan.updateOne(
    { _id: planId, "days.dayNumber": dayNum },
    {
      $set: {
        "days.$.promptStatus": "pending",
        "days.$.prompt": "",
        "days.$.promptText": { headline: "", tagline: "", offer: "", cta: "" },
        "days.$.promptEditedByUser": false,
        "days.$.lastError": "",
      },
    }
  );

  const queues = getQueues();
  await queues.posterPrompt.add(
    `regen-prompt-day${dayNum}-${plan.businessId}`,
    { contentPlanId: planId, dayNumber: dayNum }
  );

  return res.json(new ApiResponse(200, null, "Prompt regeneration queued."));
});

// ── POST /poster/welcome/:posterType/regenerate ──
const regenerateWelcomePoster = asyncHandler(async (req, res) => {
  // Only allow in development/test mode
  if (env.nodeEnv === "production") {
    throw new ApiError(403, "Regeneration is only available in test mode.");
  }

  const { posterType } = req.params; // "intro" or "about-us"
  if (!["intro", "about-us"].includes(posterType)) {
    throw new ApiError(400, "Invalid poster type. Use 'intro' or 'about-us'.");
  }

  const business = req.business;
  const Content = require("../content/content.model");
  const posterService = require("../../services/poster.service");

  // Delete old content record and local file
  const field = posterType === "intro" ? "introContentId" : "aboutUsContentId";
  const oldContentId = business.welcomePosters?.[field];
  if (oldContentId) {
    const oldContent = await Content.findById(oldContentId);
    if (oldContent?.localImagePath) {
      await posterService.deleteLocalPoster(oldContent.localImagePath);
    }
    await Content.deleteOne({ _id: oldContentId });
  }

  // Reset welcome poster status
  const doneField = posterType === "intro" ? "welcomePosters.introDone" : "welcomePosters.aboutUsDone";
  const contentField = posterType === "intro" ? "welcomePosters.introContentId" : "welcomePosters.aboutUsContentId";
  await Business.updateOne(
    { _id: business._id },
    { $set: { [doneField]: false, [contentField]: null } }
  );

  // Queue regeneration
  const queues = getQueues();
  await queues.welcomePoster.add(
    `regen-welcome-${posterType}-${business._id}`,
    {
      businessId: String(business._id),
      userId: String(req.user.id),
      posterType,
    }
  );

  return res.json(new ApiResponse(200, null, `${posterType} poster regeneration queued.`));
});

// ── GET /poster/welcome-status ──
const getWelcomeStatus = asyncHandler(async (req, res) => {
  const business = req.business;
  const wp = business.welcomePosters || {};

  const Content = require("../content/content.model");

  const normaliseUrl = (url) => {
    if (!url) return null;
    const pathPart = url.replace(/^.*?\/static\//, '');
    return `${env.storagePublicBaseUrl}/${pathPart}`;
  };

  let introData = { imageUrl: null, caption: null };
  if (wp.introContentId) {
    const content = await Content.findById(wp.introContentId).select("imageUrl caption").lean();
    if (content) {
      introData.imageUrl = normaliseUrl(content.imageUrl);
      introData.caption = content.caption || null;
    }
  }

  let aboutUsData = { imageUrl: null, caption: null };
  if (wp.aboutUsContentId) {
    const content = await Content.findById(wp.aboutUsContentId).select("imageUrl caption").lean();
    if (content) {
      aboutUsData.imageUrl = normaliseUrl(content.imageUrl);
      aboutUsData.caption = content.caption || null;
    }
  }

  return res.json(
    new ApiResponse(200, {
      introDone: wp.introDone || false,
      aboutUsDone: wp.aboutUsDone || false,
      introContentId: wp.introContentId || null,
      aboutUsContentId: wp.aboutUsContentId || null,
      introImageUrl: introData.imageUrl,
      introCaption: introData.caption,
      aboutUsImageUrl: aboutUsData.imageUrl,
      aboutUsCaption: aboutUsData.caption,
      aboutUsScheduledAt: wp.aboutUsScheduledAt || null,
    })
  );
});

module.exports = {
  getSettings,
  updateSettings,
  uploadModelImage,
  deleteModelImage,
  getActivePlan,
  editDay,
  editDayPrompt,
  regeneratePrompt,
  regenerateWelcomePoster,
  getWelcomeStatus,
};
