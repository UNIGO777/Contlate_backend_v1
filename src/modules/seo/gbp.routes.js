const express = require("express");
const checkBusinessMiddleware = require("../../middlewares/checkBusiness.middleware");
const gbpController = require("./gbp.controller");

const router = express.Router();

// All GBP routes require a completed business profile
router.use(checkBusinessMiddleware);

// GET /business/gbp/connect-url — returns Google OAuth consent URL
router.get("/connect-url", gbpController.getConnectUrl);

// GET /business/gbp/callback — Google redirects here after approval/denial
router.get("/callback", gbpController.handleCallback);

// POST /business/gbp/retry-fetch — retry fetching locations (after rate limit)
router.post("/retry-fetch", gbpController.retryFetchLocations);

// POST /business/gbp/select-location — user picks which GBP location
router.post("/select-location", gbpController.selectLocation);

// GET /business/gbp/status — check connection status
router.get("/status", gbpController.getStatus);

// GET /business/gbp/insights — cached performance metrics (views/calls/directions)
router.get("/insights", gbpController.getInsights);

// DELETE /business/gbp/disconnect — remove tokens, user can reconnect
router.delete("/disconnect", gbpController.disconnect);

module.exports = router;
