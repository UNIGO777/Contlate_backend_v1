const express = require("express");
const multer = require("multer");
const checkBusiness = require("../../middlewares/checkBusiness.middleware");
const validateMiddleware = require("../../middlewares/validate.middleware");
const posterController = require("./poster.controller");
const {
  validateUpdateSettings,
  validateEditDay,
  validateEditDayPrompt,
} = require("./poster.validation");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max for model images
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, and WebP images are allowed."));
    }
  },
});

const router = express.Router();

// All poster routes require auth (handled by parent) + completed business
router.use(checkBusiness);

// ── Settings ──
router.get("/settings", posterController.getSettings);
router.patch(
  "/settings",
  validateMiddleware(validateUpdateSettings),
  posterController.updateSettings
);

// ── Model Image ──
router.post("/model-image", upload.single("file"), posterController.uploadModelImage);
router.delete("/model-image", posterController.deleteModelImage);

// ── Content Plan ──
router.get("/plan/active", posterController.getActivePlan);
router.patch(
  "/plan/:planId/day/:dayNumber",
  validateMiddleware(validateEditDay),
  posterController.editDay
);
router.patch(
  "/plan/:planId/day/:dayNumber/prompt",
  validateMiddleware(validateEditDayPrompt),
  posterController.editDayPrompt
);
router.post(
  "/plan/:planId/day/:dayNumber/regenerate-prompt",
  posterController.regeneratePrompt
);

// ── Welcome Posters ──
router.get("/welcome-status", posterController.getWelcomeStatus);
router.post("/welcome/:posterType/regenerate", posterController.regenerateWelcomePoster);

module.exports = router;
