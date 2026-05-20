const express = require("express");
const multer = require("multer");
const validateMiddleware = require("../../middlewares/validate.middleware");
const businessController = require("./business.controller");
const seoRoutes = require("../seo/seo.routes");
const gbpRoutes = require("../seo/gbp.routes");
const aiSeoRoutes = require("../ai-seo/aiSeo.routes");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, and WebP images are allowed."));
    }
  },
});
const {
  validateCreateBusiness,
  validateUpdateBusiness,
  validateBrandAssets,
  validateGenerateDescription,
  validateSetupStart,
  validateSetupAddress,
  validateSetupPlacesMatch,
  validateSetupPlaceSelect,
  validateSetupComplete,
} = require("./business.validation");

const router = express.Router();

router.post(
  "/setup/start",
  validateMiddleware(validateSetupStart),
  businessController.startSetup
);
router.patch(
  "/setup/address",
  validateMiddleware(validateSetupAddress),
  businessController.saveSetupAddress
);
router.post(
  "/setup/places/match",
  validateMiddleware(validateSetupPlacesMatch),
  businessController.matchSetupPlaces
);
router.post(
  "/setup/places/select",
  validateMiddleware(validateSetupPlaceSelect),
  businessController.selectSetupPlace
);
router.post(
  "/setup/complete",
  validateMiddleware(validateSetupComplete),
  businessController.completeSetup
);

router.post("/", validateMiddleware(validateCreateBusiness), businessController.createBusiness);
router.get("/me", businessController.getMyBusiness);
router.patch("/me", validateMiddleware(validateUpdateBusiness), businessController.updateMyBusiness);
router.post(
  "/me/brand-assets",
  validateMiddleware(validateBrandAssets),
  businessController.updateBrandAssets
);
router.post("/me/refresh-google", businessController.refreshGoogle);

// Onboarding: server-side Places search proxy (keeps API key server-side)
router.get("/places/search", businessController.searchPlaces);

// Onboarding: AI brand story generation (v1 template, swap for real LLM later)
router.post(
  "/me/generate-description",
  validateMiddleware(validateGenerateDescription),
  businessController.generateDescription
);

// Brand: upload logo to Cloudinary
router.post(
  "/me/upload-logo",
  upload.single("file"),
  businessController.uploadLogo
);

// Brand: generate 5 AI color themes (uses logo if provided, else business info)
router.post("/me/generate-themes", businessController.generateThemes);

// SEO sub-routes: /business/seo/*
router.use("/seo", seoRoutes);

// GBP sub-routes: /business/gbp/*
router.use("/gbp", gbpRoutes);

// AI SEO sub-routes: /business/ai-seo/*
router.use("/ai-seo", aiSeoRoutes);

module.exports = router;
