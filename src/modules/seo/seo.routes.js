const express = require("express");
const checkBusinessMiddleware = require("../../middlewares/checkBusiness.middleware");
const seoController = require("./seo.controller");

const router = express.Router();

// All SEO routes require a completed business profile
router.use(checkBusinessMiddleware);

// GET /business/seo/rankings — fetch current SEO data
router.get("/rankings", seoController.getRankings);

// POST /business/seo/refresh — manual refresh (rate limited to 1/day in controller)
router.post("/refresh", seoController.refreshRankings);

// POST /business/seo/regenerate — test mode: wipe + full fresh refresh (no rate limit)
router.post("/regenerate", seoController.regenerateSeo);

module.exports = router;
