const express = require("express");
const { syncAutopilotToPlan } = require("./subscription.service");
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

// ── PhonePe S2S callback (Standard Checkout v2) ──────────────────────────
//
// PhonePe signs these with SHA256("username:password") using the credentials
// registered against this URL in the dashboard. That header is constant per
// merchant — it proves the caller knows a shared secret, nothing about the
// body. So the order state is re-read from PhonePe before anything is granted,
// rather than trusting the posted payload.
router.post(
  "/phonepe",
  express.raw({ type: "*/*", limit: "1mb" }),
  asyncHandler(async (req, res) => {
    const rawBody = req.body instanceof Buffer ? req.body.toString("utf8") : String(req.body || "");

    let body;
    try {
      body = phonepeService.verifyWebhook(rawBody, req.get("authorization"));
    } catch (err) {
      logger.warn("[phonepe webhook] rejected", { message: err.message });
      throw new ApiError(401, err.message);
    }

    const outcome = phonepeService.resolvePaymentOutcome(body);
    const merchantOrderId = outcome?.merchantOrderId || body?.payload?.merchantOrderId || "";

    if (!merchantOrderId) {
      logger.warn("[phonepe webhook] no merchantOrderId", { event: body?.event });
      return res.status(200).json(new ApiResponse(200, {}, "Nothing to do."));
    }

    // Idempotency. PhonePe retries, and a replayed success must not extend a
    // subscription a second time.
    const eventId = `${merchantOrderId}:${body?.event || "unknown"}`;
    const existing = await PaymentEvent.findOne({ provider: "phonepe", eventId });
    if (existing?.processedAt) {
      return res.status(200).json(new ApiResponse(200, { skipped: true }, "Already processed."));
    }

    const event =
      existing ||
      (await PaymentEvent.create({
        provider: "phonepe",
        eventType: body?.event || "UNKNOWN",
        eventId,
        payload: body,
      }));

    // Still pending — acknowledge so PhonePe stops retrying this one, and wait
    // for the terminal event.
    if (!outcome) {
      event.processedAt = new Date();
      await event.save();
      return res.status(200).json(new ApiResponse(200, {}, "Pending."));
    }

    // metaInfo is echoed back from the pay request; fall back to the id we
    // generated, which carries the user id between the first two dashes.
    const meta = body?.payload?.metaInfo || {};
    const userId = meta.udf1 || merchantOrderId.split("-")[1] || "";
    const planCode = meta.udf2 || "";
    const billingType = meta.udf3 || "one_time";

    if (!outcome.paid || !PLAN_DETAILS[planCode] || !userId) {
      logger.warn("[phonepe webhook] not activating", {
        merchantOrderId,
        paid: outcome.paid,
        planCode,
        hasUser: Boolean(userId),
      });
      event.processedAt = new Date();
      await event.save();
      return res.status(200).json(new ApiResponse(200, {}, "No action taken."));
    }

    // Confirm with PhonePe rather than believing the payload. The webhook
    // signature says nothing about the body's contents.
    try {
      const status = await phonepeService.getOrderStatus(merchantOrderId);
      if (status.state !== "COMPLETED") {
        logger.warn("[phonepe webhook] payload said paid, API disagrees", {
          merchantOrderId,
          apiState: status.state,
        });
        event.processedAt = new Date();
        await event.save();
        return res.status(200).json(new ApiResponse(200, {}, "Not confirmed."));
      }
    } catch (err) {
      // Could not verify — leave unprocessed so a retry can settle it rather
      // than granting a plan on an unverified claim.
      logger.error("[phonepe webhook] status check failed", {
        merchantOrderId,
        message: err.message,
      });
      throw new ApiError(503, "Could not verify payment with PhonePe.");
    }

    try {
      const result = await subscriptionService.activatePaidPlan({
        userId,
        plan: planCode,
        billingType,
        providerSubscriptionId: merchantOrderId,
        provider: "phonepe",
      });
      if (!result.activated) {
        logger.info("[phonepe webhook] nothing to activate", {
          merchantOrderId,
          reason: result.reason,
        });
      }
      event.userId = userId;
    } catch (err) {
      logger.error("[phonepe webhook] activation failed", {
        merchantOrderId,
        userId,
        message: err.message,
      });
      // Leave unprocessed so a retry can finish the job — the money is taken.
      throw new ApiError(500, "Payment captured but activation failed.");
    }

    event.processedAt = new Date();
    await event.save();

    return res.status(200).json(new ApiResponse(200, { processed: true }, "Webhook processed."));
  })
);

module.exports = router;
