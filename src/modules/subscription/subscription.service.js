const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../../config/env");
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
  };
};

const changePlan = async (userId, { plan, billingCycle }) => {
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
  } else if (is28d) {
    subscription.trialEndsAt = null;
    const ends = new Date();
    ends.setDate(ends.getDate() + 28);
    subscription.endsAt = ends;
  } else {
    subscription.trialEndsAt = null;
    subscription.endsAt      = null;
  }

  await subscription.save();
  user.plan = plan;
  await user.save();

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

  return {
    subscription:   sanitizeSubscription(subscription),
    availablePlans: getAvailablePlans(),
    token:          signAccessToken(user),
  };
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

  // Unique transaction id: userId + plan + billingType + timestamp
  const transactionId = `PPE-${userId.toString().slice(-6)}-${plan}-${resolvedBillingType}-${Date.now()}`;

  const redirectUrl  = `${baseUrl}/app/pricing?payment=success&txn=${transactionId}`;
  const callbackUrl  = `${callbackBaseUrl}/api/v1/webhooks/phonepe`;

  const result = await phonepeService.createCheckout({
    userId,
    amount,
    transactionId,
    redirectUrl,
    callbackUrl,
  });

  return result;
};

module.exports = {
  getSubscriptionByUserId,
  changePlan,
  cancelSubscription,
  createCheckout,
  ensureSubscriptionForUser,
  getAvailablePlans,
  sanitizeSubscription,
  signAccessToken,
};
