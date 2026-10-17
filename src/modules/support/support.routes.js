const express = require("express");
const validateMiddleware = require("../../middlewares/validate.middleware");
const supportController = require("./support.controller");
const { validateCreateTicket, validateReply } = require("./support.validation");

const router = express.Router();

// No checkBusiness here on purpose — someone whose onboarding is broken is
// exactly the person who needs to be able to raise a ticket.
router.post("/tickets", validateMiddleware(validateCreateTicket), supportController.createTicket);
router.get("/tickets", supportController.listTickets);
router.get("/tickets/:ticketId", supportController.getTicket);
router.post(
  "/tickets/:ticketId/reply",
  validateMiddleware(validateReply),
  supportController.replyToTicket
);
router.post("/tickets/:ticketId/close", supportController.closeTicket);

module.exports = router;
