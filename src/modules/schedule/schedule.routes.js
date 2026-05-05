const express = require("express");
const checkBusinessMiddleware = require("../../middlewares/checkBusiness.middleware");
const usageLimitMiddleware = require("../../middlewares/usageLimit.middleware");
const validateMiddleware = require("../../middlewares/validate.middleware");
const scheduleController = require("./schedule.controller");
const {
  validateCreateSchedulePayload,
  validateUpdateSchedulePayload,
} = require("./schedule.validation");

const router = express.Router();

router.use(checkBusinessMiddleware);

router.post(
  "/",
  usageLimitMiddleware("scheduledPostsCount"),
  validateMiddleware(validateCreateSchedulePayload),
  scheduleController.createSchedule
);

// Bulk create — used after onboarding to generate the 28-day plan at once
router.post("/bulk", scheduleController.bulkCreateSchedules);

router.get("/", scheduleController.listSchedules);
router.get("/:scheduleId", scheduleController.getScheduleById);
router.patch(
  "/:scheduleId",
  validateMiddleware(validateUpdateSchedulePayload),
  scheduleController.updateSchedule
);
router.delete("/:scheduleId", scheduleController.cancelSchedule);

module.exports = router;
