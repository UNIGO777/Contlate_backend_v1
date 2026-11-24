const express = require("express");
const validateMiddleware = require("../../middlewares/validate.middleware");
const subscriptionController = require("./subscription.controller");
const { validatePlanChangeInput, validateCheckoutInput } = require("./subscription.validation");

const router = express.Router();

router.get("/me", subscriptionController.getMySubscription);
router.patch("/me/plan", validateMiddleware(validatePlanChangeInput), subscriptionController.updateMyPlan);
router.post("/me/cancel", subscriptionController.cancelMySubscription);

// PhonePe checkout: creates a payment session and returns the redirect URL
router.post("/me/checkout", validateMiddleware(validateCheckoutInput), subscriptionController.createCheckout);
// Confirms a payment on return from PhonePe, without waiting for the webhook.
router.get("/me/checkout/:merchantOrderId", subscriptionController.verifyCheckout);

module.exports = router;
