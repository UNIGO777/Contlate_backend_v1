const express = require("express");
const validateMiddleware = require("../../middlewares/validate.middleware");
const businessController = require("./business.controller");
const {
  validateCreateBusiness,
  validateUpdateBusiness,
  validateBrandAssets,
  validateGenerateDescription,
} = require("./business.validation");

const router = express.Router();

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

module.exports = router;
