const express = require("express");
const asyncHandler = require("../../core/asyncHandler");
const ApiResponse = require("../../core/ApiResponse");
const ApiError = require("../../core/ApiError");
const logger = require("../../core/logger");
const paymentService = require("../../services/payment.service");
const phonepeService = require("../../services/phonepe.service");
const subscriptionService = require("./subscription.service");
const { PLANS, PLAN_DETAILS } = require("../../constants/plans");
const { BILLING_CYCLES } = require("../../constants/billingCycles");
const { SUBSCRIPTION_STATUS } = require("../../constants/subscriptionStatus");
const PaymentEvent = require("./paymentEvent.model");
const User = require("../user/user.model");
const Subscription = require("./subscription.model");

const router = express.Router();

// ── Razorpay webhook (existing) ──────────────────────────────────────────
router.post(
  "/razorpay",
  express.raw({ type: "application/json", limit: "1mb" }),
  asyncHandler(async (req, res) => {
    const rawBody = req.body instanceof Buffer ? req.body.toString("utf8") : "";
    const body    = rawBody ? JSON.parse(rawBody) : {};
    const result  = await paymentService.handleRazorpayWebhook({
      rawBody,
      signature: req.get("x-razorpay-signature"),
      body,
    });
    return res.status(200).json(new ApiResponse(200, result, "Webhook accepted."));
  })
);

// ── PhonePe S2S callback ─────────────────────────────────────────────────
router.post(
  "/phonepe",
  express.raw({ type: "*/*", limit: "1mb" }),
  asyncHandler(async (req, res) => {
    const rawBody     = req.body instanceof Buffer ? req.body.toString("utf8") : String(req.body || "");
    const xVerify     = req.get("x-verify") || "";

    let decoded;
    try {
      decoded = phonepeService.verifyWebhook(rawBody, xVerify);
    } catch (err) {
      logger.warn("[phonepe webhook] signature verification failed", { message: err.message });
      throw new ApiError(400, err.message);
    }

    const transactionId = decoded?.data?.merchantTransactionId || "";
    const eventId       = transactionId || `phonepe-${Date.now()}`;

    // Idempotency: skip if already processed
    const existing = await PaymentEvent.findOne({ provider: "phonepe", eventId });
    if (existing && existing.processedAt) {
      return res.status(200).json(new ApiResponse(200, { skipped: true }, "Already processed."));
    }

    // Persist the raw event first
    const event = existing || await PaymentEvent.create({
      provider:  "phonepe",
      eventType: decoded?.code || "UNKNOWN",
      eventId,
      payload:   decoded,
    });

    // Resolve the transaction id → userId encoded in the merchantTransactionId
    // Format: PPE-{userIdSuffix}-{plan}-{timestamp}
    const parts   = transactionId.split("-");
    const planCode = parts[2] || "";
    const userId   = decoded?.data?.merchantUserId || "";

    const outcome = phonepeService.resolvePaymentOutcome(decoded, planCode);
    if (!outcome || !userId) {
      logger.warn("[phonepe webhook] no actionable outcome", { transactionId, outcome });
      event.processedAt = new Date();
      await event.save();
      return res.status(200).json(new ApiResponse(200, {}, "No action taken."));
    }

    if (outcome.paid && PLAN_DETAILS[planCode]) {
      try {
        const user = await User.findById(userId);
        if (user) {
          const { subscription } = await subscriptionService.ensureSubscriptionForUser(userId);
          const ends = new Date();
          ends.setDate(ends.getDate() + 28);

          subscription.plan                  = planCode;
          subscription.billingCycle          = BILLING_CYCLES.CYCLE_28D;
          subscription.status                = SUBSCRIPTION_STATUS.ACTIVE;
          subscription.paymentProvider       = "phonepe";
          subscription.providerSubscriptionId = transactionId;
          subscription.startsAt              = new Date();
          subscription.endsAt               = ends;
          subscription.trialEndsAt          = null;
          await subscription.save();

          user.plan = planCode;
          await user.save();
        }
      } catch (err) {
        logger.error("[phonepe webhook] subscription activation failed", { message: err.message, userId });
      }
    }

    event.processedAt = new Date();
    event.eventType   = decoded?.code || event.eventType;
    await event.save();

    return res.status(200).json(new ApiResponse(200, { processed: true }, "Webhook processed."));
  })
);

module.exports = router;
