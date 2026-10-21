const express = require("express");
const multer = require("multer");
const checkBusiness = require("../../middlewares/checkBusiness.middleware");
const checkPlan = require("../../middlewares/checkPlan.middleware");
const { PLANS } = require("../../constants/plans");
const planController = require("./plan.controller");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
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

// All plan routes require auth (handled by parent) + completed business profile
router.use(checkBusiness);

// ── Setup (Phase 3) ──────────────────────────────────────────────────────────
// Get existing business offers + pre-populated services
router.get("/setup", planController.getSetup);
// Save / update business type + products/services + offers + auto-post time
router.post("/setup", planController.saveSetup);
// Upload a product photo. Standalone rather than keyed to a product id,
// because a product being added for the first time has no id yet — the client
// uploads, gets back a path, and includes it when it saves the setup.
router.post("/product-image", upload.single("file"), planController.uploadProductImage);

// ── Plan generation (Phase 4) ────────────────────────────────────────────────
// The 28-day plan is the paid product. Reading an existing plan stays open so
// a lapsed account can still see and publish what it already paid for.
router.post("/generate", checkPlan(PLANS.PRO), planController.triggerGenerate);
// Fetch active plan days for the frontend timeline
router.get("/active", planController.getActivePlan);

// ── Day actions (Phase 6) ────────────────────────────────────────────────────
router.post("/days/:dayNumber/approve",  planController.approveDay);
router.post("/days/:dayNumber/decline",  planController.declineDay);
// Editing the caption before it goes out is the "customise" part of a paid
// plan; canEditPoster is false on free.
router.patch("/days/:dayNumber/caption", checkPlan(PLANS.PRO), planController.updateCaption);

module.exports = router;
