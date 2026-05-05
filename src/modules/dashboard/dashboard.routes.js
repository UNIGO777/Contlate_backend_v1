const express = require("express");
const dashboardController = require("./dashboard.controller");

const router = express.Router();

router.get("/me/overview", dashboardController.getMyOverview);
router.get("/me/publish-trend", dashboardController.getMyPublishTrend);

module.exports = router;
