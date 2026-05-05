const express = require("express");
const usageController = require("./usage.controller");

const router = express.Router();

router.get("/me", usageController.getMyUsage);
router.get("/me/history", usageController.getMyUsageHistory);

module.exports = router;
