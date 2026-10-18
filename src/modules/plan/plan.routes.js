const express = require("express");
const checkBusiness = require("../../middlewares/checkBusiness.middleware");
const checkPlan = require("../../middlewares/checkPlan.middleware");
const { PLANS } = require("../../constants/plans");
const planController = require("./plan.controller");

const router = express.Router();

// All plan routes require auth (handled by parent) + completed business profile
router.use(checkBusiness);

// ── Setup (Phase 3) ──────────────────────────────────────────────────────────
// Get existing business offers + pre-populated services
router.get("/setup", planController.getSetup);
// Save / update business type + products/services + offers + auto-post time
router.post("/setup", planController.saveSetup);

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
