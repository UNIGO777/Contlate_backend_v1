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

module.exports = router;
