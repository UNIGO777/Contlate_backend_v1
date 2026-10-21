const fs = require("fs/promises");
const path = require("path");
const asyncHandler = require("../../core/asyncHandler");
const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const { ERROR_CODES } = require("../../constants/errorCodes");
const Business = require("../business/business.model");
const Content = require("../content/content.model");
const Usage = require("../usage/usage.model");
const env = require("../../config/env");
const posterService = require("../../services/poster.service");
const { PLAN_LIMITS } = require("../../constants/limits");
const { resolveOwnedUpload } = require("../../utils/safePath");

// ── POST /product-poster/generate ──
const generate = asyncHandler(async (req, res) => {
  const business = req.business;
  const {
    productName,
    productDescription,
    price,
    discount,
    features,
    language,
    style,
    size,
    quality,
    productImagePath,
  } = req.body;

  if (!productName || !productName.trim()) {
    throw new ApiError(400, "productName is required.", { code: ERROR_CODES.VALIDATION_FAILED });
  }

  // Check usage limits
  const dateKey = new Date().toISOString().split("T")[0];
  const usage = await Usage.findOne({ userId: req.user.id, dateKey }).lean();
  const limit = PLAN_LIMITS[req.user.plan]?.aiPostersPerDay ?? 1;
  if (!env.relaxPlanLimits && (usage?.aiPostersCount || 0) >= limit) {
    // A plan with no posters at all is a different message from one that has
    // run out for today.
    throw new ApiError(
      429,
      limit === 0
        ? "Creating posters on demand is part of the Pro plan."
        : "You have used today's posters. More tomorrow, or upgrade for a higher limit.",
      { code: "POSTER_LIMIT_REACHED", details: { limit } }
    );
  }

  // Build a product-focused day plan for the prompt generator
  const dayPlan = {
    topic: `${productName.trim()} — Product Showcase`,
    description: [
      productDescription || "",
      price ? `Price: ${price}` : "",
      discount ? `Discount: ${discount}` : "",
      features ? `Features: ${features}` : "",
    ]
      .filter(Boolean)
      .join(". "),
    contentType: "product",
  };

  // Generate prompt. This also vets the input: the cheap text call decides
  // whether the topic is something we can advertise at all, so junk never
  // reaches the expensive image call and never costs the user a poster.
  let promptResult;
  try {
    promptResult = await posterService.generatePosterPrompt(business, dayPlan, {
      language,
      style,
      size,
    });
  } catch (err) {
    if (err.isRejectedInput) {
      throw new ApiError(400, err.message, {
        code: ERROR_CODES.POSTER_INPUT_REJECTED,
      });
    }
    throw err;
  }

  // ── Reference images ────────────────────────────────────────────────────
  // The upload endpoint below has always existed, but what it returned was
  // never read back here — every poster fell through to the model image and
  // the product the client had photographed was ignored. Both are passed now.
  let modelImageBuffer = null;
  if (business.posterSettings?.useModelImage && business.posterSettings?.modelImagePath) {
    modelImageBuffer = await posterService.readModelImageBuffer(
      business.posterSettings.modelImagePath
    );
  }

  // The path came from our own upload response, but it travelled through the
  // client to get here, so it is checked rather than trusted.
  let productImageBuffer = null;
  const safeProductPath = resolveOwnedUpload(productImagePath, "product-images", business._id);
  if (safeProductPath) {
    productImageBuffer = await posterService.readModelImageBuffer(safeProductPath).catch(() => null);
  }

  const sizeKey = size || business.posterSettings?.defaultSize || "4:5";
  const qualityKey = quality || business.posterSettings?.defaultQuality || "auto";

  // Generate image
  const imageResult = await posterService.generatePosterImage(
    promptResult.fullPrompt,
    {
      headline: promptResult.headline,
      tagline: promptResult.tagline,
      offer: promptResult.offer,
      cta: promptResult.cta,
    },
    business,
    {
      size: sizeKey,
      quality: qualityKey,
      modelImageBuffer,
      productImageBuffer,
      includeModel: business.posterSettings?.includeModel === true,
    }
  );

  // Save locally
  const { localPath, publicUrl } = await posterService.savePosterLocally(
    imageResult.imageBuffer,
    business._id,
    `product_${Date.now()}`
  );

  // Create content record
  const content = await Content.create({
    userId: req.user.id,
    businessId: business._id,
    imageUrl: publicUrl,
    caption: `${promptResult.headline || productName} — ${business.businessName}`,
    status: "ready",
    sourceType: "product-poster",
    tags: ["product", productName.trim()],
    localImagePath: localPath,
    generationCost: {
      gptCost: promptResult.gptCost,
      imageCost: imageResult.imageCost,
      totalCost: promptResult.gptCost + imageResult.imageCost,
      inputTokens: promptResult.inputTokens,
      outputTokens: promptResult.outputTokens,
      imageSize: imageResult.apiSize,
      imageQuality: imageResult.quality,
    },
  });

  // Increment usage
  await Usage.updateOne(
    { userId: req.user.id, dateKey },
    { $inc: { aiPostersCount: 1 } },
    { upsert: true }
  );

  return res.json(
    new ApiResponse(200, {
      contentId: content._id,
      imageUrl: publicUrl,
      promptText: {
        headline: promptResult.headline,
        tagline: promptResult.tagline,
        offer: promptResult.offer,
        cta: promptResult.cta,
      },
      cost: content.generationCost,
    })
  );
});

// ── POST /product-poster/product-image ──
const uploadProductImage = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, "No image file provided.", { code: ERROR_CODES.VALIDATION_FAILED });
  }

  const business = req.business;
  const dir = path.resolve(env.storageLocalDir, "product-images", String(business._id));
  await fs.mkdir(dir, { recursive: true });

  const ext =
    req.file.mimetype === "image/png" ? "png" : req.file.mimetype === "image/webp" ? "webp" : "jpg";
  const filename = `product_${Date.now()}.${ext}`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, req.file.buffer);

  const publicUrl = `${env.storagePublicBaseUrl}/files/product-images/${business._id}/${filename}`;

  return res.json(
    new ApiResponse(200, { productImageUrl: publicUrl, productImagePath: filePath }, "Product image uploaded.")
  );
});

// ── DELETE /product-poster/product-image/:filename ──
const deleteProductImage = asyncHandler(async (req, res) => {
  const business = req.business;
  const { filename } = req.params;

  if (!filename || filename.includes("..")) {
    throw new ApiError(400, "Invalid filename.", { code: ERROR_CODES.VALIDATION_FAILED });
  }

  const filePath = path.resolve(env.storageLocalDir, "product-images", String(business._id), filename);
  await fs.unlink(filePath).catch(() => {});

  return res.json(new ApiResponse(200, null, "Product image removed."));
});

module.exports = {
  generate,
  uploadProductImage,
  deleteProductImage,
};
