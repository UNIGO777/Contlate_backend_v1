const express = require("express");
const authMiddleware = require("../../middlewares/auth.middleware");
const checkBusinessMiddleware = require("../../middlewares/checkBusiness.middleware");
const publishController = require("./publish.controller");

const router = express.Router();

router.use(authMiddleware);
router.use(checkBusinessMiddleware);

router.post("/now", publishController.publishNow);
router.get("/log", publishController.listLogs);
router.get("/log/:scheduleId", publishController.getLogsBySchedule);

module.exports = router;
