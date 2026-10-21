/**
 * Renewal reminders.
 *
 * Nothing used to warn a client that their plan was about to lapse. The
 * RENEWAL_REMINDER notification existed but was never sent by anything, so
 * the first sign was the posts stopping. This is what sends it.
 *
 * Reminders go out at 3 days, 1 day and on the day itself. Three touches is
 * enough to be heard without becoming noise, and the three-day lead is what
 * gives someone time to act before anything stops.
 *
 * The copy splits on auto-renew, not on plan:
 *   monthly / yearly → "renews, you will be charged" (they may want to cancel)
 *   28d / one-off    → "ends, renew to continue"     (nothing will happen on
 *                      its own)
 */
const logger = require("../core/logger");
const Subscription = require("../modules/subscription/subscription.model");
const User = require("../modules/user/user.model");
const JobLog = require("./jobLog.model");
const { PLANS, PLAN_DETAILS, getPriceForPlan } = require("../constants/plans");
const { BILLING_CYCLES } = require("../constants/billingCycles");
const { SUBSCRIPTION_STATUS } = require("../constants/subscriptionStatus");
const { sendAppNotification } = require("../utils/notifications");

const JOB_TYPE = "renewalReminder";
// Hourly rather than daily: a daily tick would have to pick an hour, and a
// restart near that hour could skip a day entirely. The per-cycle dedupe
// below makes extra ticks harmless.
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

// Days before expiry that earn a reminder, soonest last so the most urgent
// one wins if several are somehow due at once.
const OFFSETS = [3, 1, 0];

const DAY_MS = 24 * 60 * 60 * 1000;

const AUTO_RENEWING = [BILLING_CYCLES.MONTHLY, BILLING_CYCLES.YEARLY];

const formatDate = (d) =>
  new Date(d).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

/**
 * Whole days from now until `endsAt`, rounded DOWN.
 *
 * Down, not up, because the job only ever looks at subscriptions that have
 * not expired yet. Rounding up makes anything still in the future report at
 * least 1, so the day-of reminder could never fire — a plan with an hour left
 * would read as "1 day". Flooring gives 0 for the final day, which is both
 * the correct offset and the right word in the email.
 */
const daysUntil = (endsAt, now) => Math.floor((new Date(endsAt) - now) / DAY_MS);

/** Which offset, if any, this subscription is due a reminder for. */
const dueOffset = (sub, now) => {
  const left = daysUntil(sub.endsAt, now);
  if (left < 0 || left > OFFSETS[0]) return null;
  // Pick the smallest offset that has been reached, so a plan 3 days out
  // matches 3 and one 2 days out also matches 3 (it is past that mark and
  // has not been reminded yet).
  const candidates = OFFSETS.filter((o) => left <= o).sort((a, b) => b - a);
  for (const offset of candidates) {
    if (!(sub.remindersSent || []).includes(offset)) return offset;
  }
  return null;
};

const runOnce = async () => {
  const now = new Date();
  const horizon = new Date(now.getTime() + (OFFSETS[0] + 1) * DAY_MS);

  const subs = await Subscription.find({
    status: SUBSCRIPTION_STATUS.ACTIVE,
    plan: { $ne: PLANS.BASIC },
    endsAt: { $ne: null, $gte: now, $lte: horizon },
  }).limit(500);

  let sent = 0;

  for (const sub of subs) {
    try {
      // endsAt moving means a new cycle: the previous cycle's reminders must
      // not suppress this one's.
      if (
        !sub.remindersForEndsAt ||
        new Date(sub.remindersForEndsAt).getTime() !== new Date(sub.endsAt).getTime()
      ) {
        sub.remindersSent = [];
        sub.remindersForEndsAt = sub.endsAt;
      }

      const offset = dueOffset(sub, now);
      if (offset === null) {
        if (sub.isModified()) await sub.save();
        continue;
      }

      const user = await User.findById(sub.userId).select("name email").lean();
      if (!user) continue;

      const autoRenews = AUTO_RENEWING.includes(sub.billingCycle);
      const planName = PLAN_DETAILS[sub.plan]?.name || sub.plan;
      const billingType =
        sub.billingCycle === BILLING_CYCLES.YEARLY ? "yearly" : "monthly";

      await sendAppNotification(
        sub.userId,
        "RENEWAL_REMINDER",
        {
          planName,
          daysLeft: Math.max(0, daysUntil(sub.endsAt, now)),
          endsOn: formatDate(sub.endsAt),
          autoRenews,
          price: autoRenews ? getPriceForPlan(sub.plan, billingType) : undefined,
          cycleLabel: sub.billingCycle === BILLING_CYCLES.YEARLY ? "year" : "month",
        },
        { userEmail: user.email, userName: user.name }
      );

      sub.remindersSent = [...(sub.remindersSent || []), offset];
      await sub.save();
      sent++;

      logger.info("[renewalReminder] sent", {
        userId: String(sub.userId),
        plan: sub.plan,
        offset,
        autoRenews,
      });
    } catch (err) {
      // One client's reminder failing must not stop the rest of the batch.
      logger.warn("[renewalReminder] failed for subscription", {
        subscriptionId: String(sub._id),
        message: err.message,
      });
    }
  }

  if (sent) {
    await JobLog.create({
      type: JOB_TYPE,
      status: "success",
      attempts: 1,
      lastRunAt: now,
    }).catch(() => {});
    logger.info("[renewalReminder] run complete", { checked: subs.length, sent });
  }

  return sent;
};

let timer = null;

const start = (intervalMs = DEFAULT_INTERVAL_MS) => {
  if (timer) return timer;
  const tick = () =>
    runOnce().catch((err) =>
      logger.error("[renewalReminder] tick failed", { message: err.message })
    );
  setTimeout(tick, 20_000);
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  logger.info("[renewalReminder] started", { intervalMs });
  return timer;
};

const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = { start, stop, runOnce, dueOffset, daysUntil, OFFSETS };
