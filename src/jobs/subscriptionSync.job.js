const logger = require("../core/logger");
const { PLANS } = require("../constants/plans");
const { SUBSCRIPTION_STATUS } = require("../constants/subscriptionStatus");
const Subscription = require("../modules/subscription/subscription.model");
const User = require("../modules/user/user.model");

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly

const expireDueTrials = async (now) => {
  const due = await Subscription.find({
    status: SUBSCRIPTION_STATUS.TRIALING,
    trialEndsAt: { $ne: null, $lte: now },
  });

  for (const sub of due) {
    sub.status = SUBSCRIPTION_STATUS.EXPIRED;
    sub.plan = PLANS.BASIC;
    sub.endsAt = now;
    await sub.save();
    await User.updateOne({ _id: sub.userId }, { $set: { plan: PLANS.BASIC } });
    logger.info("[subscriptionSync] trial expired", { userId: sub.userId.toString() });
  }
  return due.length;
};

const expireDuePaidPlans = async (now) => {
  const due = await Subscription.find({
    status: SUBSCRIPTION_STATUS.ACTIVE,
    endsAt: { $ne: null, $lte: now },
  });

  for (const sub of due) {
    sub.status = SUBSCRIPTION_STATUS.EXPIRED;
    sub.plan = PLANS.BASIC;
    await sub.save();
    await User.updateOne({ _id: sub.userId }, { $set: { plan: PLANS.BASIC } });
    logger.info("[subscriptionSync] subscription expired", { userId: sub.userId.toString() });
  }
  return due.length;
};

const runOnce = async () => {
  const now = new Date();
  const trials = await expireDueTrials(now);
  const paid = await expireDuePaidPlans(now);
  if (trials || paid) {
    logger.info("[subscriptionSync] sweep complete", { trials, paid });
  }
  return { trials, paid };
};

let timer = null;

const start = (intervalMs = DEFAULT_INTERVAL_MS) => {
  if (timer) return timer;
  const tick = async () => {
    try {
      await runOnce();
    } catch (err) {
      logger.error("[subscriptionSync] sweep failed", {
        message: err.message,
        stack: err.stack,
      });
    }
  };
  // Run once on boot, then on a fixed interval.
  tick();
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = { start, stop, runOnce };
