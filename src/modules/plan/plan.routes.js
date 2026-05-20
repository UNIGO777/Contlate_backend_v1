const express = require("express");
const checkBusiness = require("../../middlewares/checkBusiness.middleware");
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
// Trigger 28-day plan generation via OpenAI
router.post("/generate", planController.triggerGenerate);
// Fetch active plan days for the frontend timeline
router.get("/active", planController.getActivePlan);

// ── Day actions (Phase 6) ────────────────────────────────────────────────────
router.post("/days/:dayNumber/approve",  planController.approveDay);
router.post("/days/:dayNumber/decline",  planController.declineDay);
router.patch("/days/:dayNumber/caption", planController.updateCaption);

module.exports = router;
