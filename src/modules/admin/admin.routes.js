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
// The posters and captions built for this account.
router.get("/users/:userId/content", adminController.listUserContent);
router.post("/users/:userId/suspend", adminController.suspendUser);
router.post("/users/:userId/unsuspend", adminController.unsuspendUser);
router.patch("/users/:userId/subscription", validateMiddleware(validateEditSubscription), adminController.editUserSubscription);
router.post("/users/:userId/grant-plan", validateMiddleware(validateGrantPlan), adminController.grantUserPlan);

router.get("/subscriptions", adminController.listSubscriptions);

router.get("/schedules", adminController.listSchedules);
router.post("/schedules/:scheduleId/retry", adminController.retrySchedule);

router.get("/jobs/logs", adminController.listJobLogs);
router.get("/payment-events", adminController.listPaymentEvents);

router.post("/email/blast", adminController.sendEmailBlast);
router.get("/email/context", adminController.getEmailBlastContext);
router.get("/notifications", adminController.listAdminNotifications);

// ── Content & GBP ───────────────────────────────────────────────────────────
// Cross-account views. A plan or a Google post that stopped working is
// invisible from inside the app — the owner just sees nothing appear.
router.get("/plans", adminController.listPlans);
router.get("/content", adminController.listContent);
router.get("/gbp-posts", adminController.listGbpPosts);
router.get("/seo", adminController.listSeo);

// ── Support ─────────────────────────────────────────────────────────────────
// The other half of the ticket system: until now a user could write in and
// nothing could write back.
router.get("/support/tickets", adminController.listTickets);
router.get("/support/tickets/:ticketId", adminController.getTicket);
router.post("/support/tickets/:ticketId/reply", adminController.replyToTicket);
router.patch("/support/tickets/:ticketId/status", adminController.setTicketStatus);

module.exports = router;
