const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../../config/env");
const logger = require("../../core/logger");
const PaymentEvent = require("./paymentEvent.model");
const { ERROR_CODES } = require("../../constants/errorCodes");
const ApiError = require("../../core/ApiError");
const { PLANS, PLAN_DETAILS, getPriceForPlan } = require("../../constants/plans");
const { BILLING_CYCLES } = require("../../constants/billingCycles");
const { SUBSCRIPTION_STATUS } = require("../../constants/subscriptionStatus");
const phonepeService = require("../../services/phonepe.service");
const User = require("../user/user.model");
const Subscription = require("./subscription.model");

const buildTokenPayload = (user) => ({
  id:    user._id.toString(),
  role:  user.role,
  plan:  user.plan,
  email: user.email,
});

const signAccessToken = (user) =>
  jwt.sign(buildTokenPayload(user), env.jwtSecret, { expiresIn: env.jwtExpiresIn });

const sanitizeSubscription = (subscription) => ({
  id:                      subscription._id.toString(),
  userId:                  subscription.userId.toString(),
  plan:                    subscription.plan,
  planDetails:             PLAN_DETAILS[subscription.plan] || null,
  status:                  subscription.status,
  billingCycle:            subscription.billingCycle,
  paymentProvider:         subscription.paymentProvider,
  providerCustomerId:      subscription.providerCustomerId,
  providerSubscriptionId:  subscription.providerSubscriptionId,
  startsAt:                subscription.startsAt,
  endsAt:                  subscription.endsAt,
  trialEndsAt:             subscription.trialEndsAt,
  createdAt:               subscription.createdAt,
  updatedAt:               subscription.updatedAt,
});

const getAvailablePlans = () => Object.values(PLAN_DETAILS);

const getUserOrFail = async (userId) => {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, "User not found.");
  return user;
};

const ensureSubscriptionForUser = async (userId) => {
  const user = await getUserOrFail(userId);
  let subscription = await Subscription.findOne({ userId });
  if (!subscription) {
    subscription = await Subscription.create({
      userId:      user._id,
      plan:        user.plan || PLANS.BASIC,
      status:      SUBSCRIPTION_STATUS.TRIALING,
      billingCycle: BILLING_CYCLES.MONTHLY,
      startsAt:    user.createdAt || new Date(),
      trialEndsAt: user.trialEndsAt || null,
    });
  }
  return { user, subscription };
};

const getSubscriptionByUserId = async (userId) => {
  const { subscription } = await ensureSubscriptionForUser(userId);
  return {
    subscription:   sanitizeSubscription(subscription),
    availablePlans: getAvailablePlans(),
    // The app uses this to decide between activating a plan outright and
    // sending the user to the payment page.
    directActivation: env.allowDirectPlanChange,
  };
};

// Auto-posting is switched off for free accounts, and nothing switched it
// back on when they paid — so a paying user's plan generated posters that the
// scheduler then refused to queue, and nothing ever went live.
const syncAutopilotToPlan = async (userId, plan) => {
  try {
    const Business = require("../business/business.model");
    await Business.updateMany(
      { userId },
      { $set: { "autopilot.enabled": plan !== PLANS.BASIC } }
    );
  } catch (err) {
    // Never fail a plan change over this; the toggle is also user-editable.
    logger.warn("[subscription] autopilot sync failed", { message: err.message });
  }
};

const changePlan = async (userId, { plan, billingCycle }) => {
  // Without this guard the endpoint is a free upgrade for anyone who finds
  // it — it sets the plan directly, with no payment anywhere in the path.
  // Downgrading to the free plan is always allowed.
  if (!env.allowDirectPlanChange && plan !== PLANS.BASIC) {
    throw new ApiError(403, "Plan changes go through checkout.", {
      code: ERROR_CODES.PLAN_UPGRADE_REQUIRED,
    });
  }

  const { user, subscription } = await ensureSubscriptionForUser(userId);

  const is28d = billingCycle === BILLING_CYCLES.CYCLE_28D;

  subscription.plan         = plan;
  subscription.billingCycle = billingCycle || BILLING_CYCLES.MONTHLY;
  subscription.status       = plan === PLANS.BASIC
    ? SUBSCRIPTION_STATUS.TRIALING
    : SUBSCRIPTION_STATUS.ACTIVE;
  subscription.startsAt = new Date();

  if (plan === PLANS.BASIC) {
    subscription.trialEndsAt = user.trialEndsAt || subscription.trialEndsAt;
    subscription.endsAt      = null;
  } else {
    subscription.trialEndsAt = null;

    // Every paid cycle gets an end date. Monthly and yearly used to be left
    // null, and the expiry job only matches `endsAt: { $ne: null, $lte: now }`
    // — so those plans never lapsed. Anyone on monthly had a permanent paid
    // account after one payment, and the panel had no date to show.
    const ends = new Date();
    if (is28d) ends.setDate(ends.getDate() + 28);
    else if (billingCycle === BILLING_CYCLES.YEARLY) ends.setFullYear(ends.getFullYear() + 1);
    else ends.setMonth(ends.getMonth() + 1);
    subscription.endsAt = ends;
  }

  await subscription.save();
  user.plan = plan;
  await user.save();
  await syncAutopilotToPlan(userId, plan);

  return {
    subscription:   sanitizeSubscription(subscription),
    availablePlans: getAvailablePlans(),
    token:          signAccessToken(user),
  };
};

const cancelSubscription = async (userId) => {
  const { user, subscription } = await ensureSubscriptionForUser(userId);

  subscription.status  = SUBSCRIPTION_STATUS.CANCELLED;
  subscription.endsAt  = new Date();
  subscription.plan    = PLANS.BASIC;
  await subscription.save();

  user.plan = PLANS.BASIC;
  await user.save();
  await syncAutopilotToPlan(userId, PLANS.BASIC);

  return {
    subscription:   sanitizeSubscription(subscription),
    availablePlans: getAvailablePlans(),
    token:          signAccessToken(user),
  };
};

/**
 * Put a user on a paid plan after a payment has been confirmed.
 *
 * Shared by the PhonePe webhook and by the app's verify-on-return call, so a
 * payment lands the same way whichever arrives first. Writing this twice is
 * how the two paths drift apart — one of them ends up granting the wrong
 * cycle, or forgetting to reset the renewal reminders.
 *
 * The caller is responsible for having CONFIRMED the payment with the
 * provider. This function does not check; it grants.
 *
 * Idempotent: re-running for the same providerSubscriptionId leaves the
 * existing dates alone rather than extending the plan again.
 *
 * @returns {Promise<{activated: boolean, reason?: string, endsAt?: Date}>}
 */
const activatePaidPlan = async ({ userId, plan, billingType, providerSubscriptionId, provider = "phonepe" }) => {
  if (!PLAN_DETAILS[plan]) return { activated: false, reason: "unknown plan" };

  const user = await User.findById(userId);
  if (!user) return { activated: false, reason: "user not found" };

  const { subscription } = await ensureSubscriptionForUser(userId);

  // Already granted for this exact payment — do not extend a second time.
  if (
    providerSubscriptionId &&
    subscription.providerSubscriptionId === providerSubscriptionId &&
    subscription.status === SUBSCRIPTION_STATUS.ACTIVE
  ) {
    return { activated: false, reason: "already active for this order", endsAt: subscription.endsAt };
  }

  const cycleMap = {
    one_time: BILLING_CYCLES.ONE_TIME,
    monthly: BILLING_CYCLES.MONTHLY,
    yearly: BILLING_CYCLES.YEARLY,
  };
  const cycle = cycleMap[billingType] || BILLING_CYCLES.ONE_TIME;

  // Match the end date to what was actually bought.
  const ends = new Date();
  if (cycle === BILLING_CYCLES.YEARLY) ends.setFullYear(ends.getFullYear() + 1);
  else if (cycle === BILLING_CYCLES.MONTHLY) ends.setMonth(ends.getMonth() + 1);
  else ends.setDate(ends.getDate() + 28);

  subscription.plan = plan;
  subscription.billingCycle = cycle;
  subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
  subscription.paymentProvider = provider;
  subscription.providerSubscriptionId = providerSubscriptionId || "";
  subscription.startsAt = new Date();
  subscription.endsAt = ends;
  subscription.trialEndsAt = null;
  // New cycle — the previous cycle's reminders must not suppress this one's.
  subscription.remindersSent = [];
  subscription.remindersForEndsAt = ends;
  await subscription.save();

  user.plan = plan;
  await user.save();
  await syncAutopilotToPlan(user._id, plan);

  logger.info("[subscription] paid plan activated", {
    userId: String(user._id),
    plan,
    cycle,
    endsAt: ends.toISOString(),
  });

  return { activated: true, endsAt: ends };
};

// Creates a PhonePe checkout session for a paid plan.
// Returns { redirectUrl, transactionId } — frontend redirects the user to redirectUrl.
const createCheckout = async (userId, { plan, billingType }, { baseUrl, callbackBaseUrl }) => {
  const planDetails = PLAN_DETAILS[plan];
  if (!planDetails) throw new ApiError(400, "Invalid plan.");

  const resolvedBillingType = billingType || "one_time";
  const amount = getPriceForPlan(plan, resolvedBillingType);
  if (!amount) throw new ApiError(400, "Cannot checkout a free plan.");

  if (!phonepeService.isConfigured()) {
    throw new ApiError(501, "PhonePe is not configured on this server.");
  }

  // Unique per attempt. The webhook carries this back, and it is the only
  // thing tying PhonePe's order to one of our users — so the full user id goes
  // in, not a 6-character suffix. Suffixes are not unique across users, and
  // the old code then read the user from a field PhonePe no longer sends.
  const merchantOrderId = `PPE-${userId.toString()}-${Date.now()}`;

  const redirectUrl = `${baseUrl}/app/pricing?payment=done&order=${merchantOrderId}`;

  // The callback URL is registered once in the PhonePe dashboard rather than
  // sent per request, so callbackBaseUrl is no longer used here. Kept in the
  // signature because the controller still passes it.
  void callbackBaseUrl;

  const result = await phonepeService.createCheckout({
    merchantOrderId,
    amount,
    redirectUrl,
    // Echoed back on the webhook, which saves parsing them out of the id.
    metaInfo: {
      udf1: String(userId),
      udf2: plan,
      udf3: resolvedBillingType,
    },
  });

  // Recorded now so a webhook that arrives before the user returns still has
  // something to match against.
  await PaymentEvent.create({
    userId,
    provider: "phonepe",
    eventType: "checkout.created",
    eventId: merchantOrderId,
    payload: { plan, billingType: resolvedBillingType, amount, orderId: result.orderId },
    processedAt: new Date(),
  }).catch((err) =>
    logger.warn("[subscription] could not record checkout", { message: err.message })
  );

  return result;
};

/**
 * Confirm a checkout with PhonePe and activate the plan if it succeeded.
 *
 * Called when the user comes back from the payment page. The webhook is the
 * fast path, but it can be late, lost, or blocked by a firewall — and the user
 * is standing there looking at the screen. This asks PhonePe directly so the
 * return journey does not depend on a callback arriving.
 *
 * Both paths end in activatePaidPlan, which is idempotent, so whichever gets
 * there first wins and the other is a no-op.
 *
 * @returns {Promise<{state: string, activated: boolean, plan?: string}>}
 */
const verifyCheckout = async (userId, merchantOrderId) => {
  if (!merchantOrderId) throw new ApiError(400, "An order id is required.");

  // The order id embeds the user it was created for. Without this check any
  // signed-in user could confirm somebody else's payment onto their own
  // account by passing a borrowed order id.
  const owner = merchantOrderId.split("-")[1] || "";
  if (owner !== String(userId)) {
    throw new ApiError(403, "That order does not belong to this account.");
  }

  const status = await phonepeService.getOrderStatus(merchantOrderId);

  if (status.state !== "COMPLETED") {
    return { state: status.state || "UNKNOWN", activated: false };
  }

  // What was bought is recorded when the checkout is created, so a tampered
  // client cannot ask to be given a plan it did not pay for.
  const record = await PaymentEvent.findOne({
    provider: "phonepe",
    eventId: merchantOrderId,
  }).lean();

  const plan = record?.payload?.plan;
  const billingType = record?.payload?.billingType || "one_time";

  if (!plan) {
    logger.error("[subscription] paid order has no stored plan", { merchantOrderId });
    throw new ApiError(500, "Payment succeeded but the plan could not be determined.");
  }

  const result = await activatePaidPlan({
    userId,
    plan,
    billingType,
    providerSubscriptionId: merchantOrderId,
    provider: "phonepe",
  });

  return { state: "COMPLETED", activated: result.activated, plan };
};

module.exports = {
  syncAutopilotToPlan,
  getSubscriptionByUserId,
  changePlan,
  cancelSubscription,
  createCheckout,
  activatePaidPlan,
  verifyCheckout,
  ensureSubscriptionForUser,
  getAvailablePlans,
  sanitizeSubscription,
  signAccessToken,
};
