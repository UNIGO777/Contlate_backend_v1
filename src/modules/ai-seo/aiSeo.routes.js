const express = require("express");
const checkBusinessMiddleware = require("../../middlewares/checkBusiness.middleware");
const aiSeoController = require("./aiSeo.controller");

const router = express.Router();

// All AI SEO routes require a completed business profile
router.use(checkBusinessMiddleware);

// GET /business/ai-seo/insights — fetch current keyword data + history
router.get("/insights", aiSeoController.getInsights);

// POST /business/ai-seo/generate — first-time keyword generation
router.post("/generate", aiSeoController.generate);

// POST /business/ai-seo/refresh — monthly rank update (Advanced only)
router.post("/refresh", aiSeoController.refresh);

// PATCH /business/ai-seo/keyword/:index/toggle — toggle workOnIt (Advanced only)
router.patch("/keyword/:index/toggle", aiSeoController.toggleKeyword);

// POST /business/ai-seo/new-cycle — start new 3-month cycle (Advanced only)
router.post("/new-cycle", aiSeoController.newCycle);

module.exports = router;
