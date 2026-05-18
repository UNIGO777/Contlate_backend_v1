const crypto = require("crypto");
const env = require("../config/env");
const ApiError = require("../core/ApiError");
const logger = require("../core/logger");
const { PLANS } = require("../constants/plans");
const { SUBSCRIPTION_STATUS } = require("../constants/subscriptionStatus");
const Subscription = require("../modules/subscription/subscription.model");
const User = require("../modules/user/user.model");
const PaymentEvent = require("../modules/subscription/paymentEvent.model");
const seoPlanChange = require("./seoPlanChange.service");

const PROVIDER_RAZORPAY = "razorpay";

const verifyRazorpaySignature = (rawBody, signatureHeader) => {
  const secret = env.razorpay.webhookSecret;
  if (!secret) {
    throw new ApiError(500, "Razorpay webhook secret is not configured.");
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signatureHeader || ""), "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(400, "Invalid webhook signature.");
  }
};

const findUserFromPayload = async (payload) => {
  const sub = payload?.payload?.subscription?.entity;
  const notes = sub?.notes || payload?.payload?.payment?.entity?.notes || {};
  if (notes.userId) {
    return User.findById(notes.userId);
  }
  if (sub?.id) {
    const existing = await Subscription.findOne({ providerSubscriptionId: sub.id });
    if (existing) return User.findById(existing.userId);
  }
  return null;
};

const applyEventToSubscription = async (eventType, payload) => {
  const user = await findUserFromPayload(payload);
  if (!user) {
    logger.warn("[payment] event has no resolvable user", { eventType });
    return null;
  }

  const subEntity = payload?.payload?.subscription?.entity;
  let subscription = await Subscription.findOne({ userId: user._id });
  if (!subscription) {
    subscription = await Subscription.create({
      userId: user._id,
      plan: user.plan || PLANS.BASIC,
      status: SUBSCRIPTION_STATUS.TRIALING,
      billingCycle: "monthly",
      paymentProvider: PROVIDER_RAZORPAY,
    });
  }

  // Capture old plan for SEO plan-change detection
  const oldPlan = user.plan;

  switch (eventType) {
    case "subscription.activated":
    case "subscription.charged":
    case "subscription.resumed":
      subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
      subscription.plan = PLANS.PRO;
      subscription.paymentProvider = PROVIDER_RAZORPAY;
      if (subEntity?.id) subscription.providerSubscriptionId = subEntity.id;
      if (subEntity?.current_end) {
        subscription.endsAt = new Date(subEntity.current_end * 1000);
      }
      user.plan = PLANS.PRO;
      break;
    case "subscription.cancelled":
    case "subscription.completed":
      subscription.status = SUBSCRIPTION_STATUS.CANCELLED;
      subscription.endsAt = new Date();
      subscription.plan = PLANS.BASIC;
      user.plan = PLANS.BASIC;
      break;
    case "subscription.halted":
    case "subscription.paused":
      subscription.status = SUBSCRIPTION_STATUS.EXPIRED;
      subscription.plan = PLANS.BASIC;
      user.plan = PLANS.BASIC;
      break;
    default:
      logger.info("[payment] unhandled event type", { eventType });
      return subscription;
  }

  await subscription.save();
  await user.save();

  // Trigger SEO plan change handler (fire-and-forget)
  const newPlan = user.plan;
  if (oldPlan !== newPlan) {
    seoPlanChange.handlePlanChange(user._id, oldPlan, newPlan).catch((err) => {
      logger.error("[payment] SEO plan change handler failed", {
        userId: user._id,
        oldPlan,
        newPlan,
        error: err.message,
      });
    });
  }

  return subscription;
};

const handleRazorpayWebhook = async ({ rawBody, signature, body }) => {
  verifyRazorpaySignature(rawBody, signature);

  const eventType = body?.event;
  const eventId = body?.id || body?.payload?.payment?.entity?.id || `${eventType}-${Date.now()}`;

  if (!eventType) {
    throw new ApiError(400, "Missing event type.");
  }

  const existing = await PaymentEvent.findOne({ provider: PROVIDER_RAZORPAY, eventId });
  if (existing?.processedAt) {
    return { duplicate: true };
  }

  const record =
    existing ||
    (await PaymentEvent.create({
      provider: PROVIDER_RAZORPAY,
      eventType,
      eventId,
      payload: body,
    }));

  await applyEventToSubscription(eventType, body);

  record.processedAt = new Date();
  await record.save();

  return { processed: true };
};

module.exports = {
  handleRazorpayWebhook,
};
