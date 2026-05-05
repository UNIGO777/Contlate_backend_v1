const express = require("express");
const adminMiddleware = require("../../middlewares/admin.middleware");
const validateMiddleware = require("../../middlewares/validate.middleware");
const adminController = require("./admin.controller");
const { validateEditSubscription, validateGrantPlan } = require("./admin.validation");

const router = express.Router();

// authMiddleware already applied globally in routes/index.js
router.use(adminMiddleware);

router.get("/stats", adminController.getStats);

router.get("/users", adminController.listUsers);
router.get("/users/:userId", adminController.getUser);
router.post("/users/:userId/suspend", adminController.suspendUser);
router.post("/users/:userId/unsuspend", adminController.unsuspendUser);
router.patch("/users/:userId/subscription", validateMiddleware(validateEditSubscription), adminController.editUserSubscription);
router.post("/users/:userId/grant-plan", validateMiddleware(validateGrantPlan), adminController.grantUserPlan);

router.get("/subscriptions", adminController.listSubscriptions);

router.get("/schedules", adminController.listSchedules);
router.post("/schedules/:scheduleId/retry", adminController.retrySchedule);

router.get("/jobs/logs", adminController.listJobLogs);
router.get("/payment-events", adminController.listPaymentEvents);

module.exports = router;
