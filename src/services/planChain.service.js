/**
 * Content plan chain.
 *
 * The plan used to be calendar-driven: all 28 days got fixed dates when the
 * plan was created, and the scheduler generated whatever the calendar said was
 * due. That drifted — welcome posters published on their own timeline while
 * the plan still held days pointing at them, so Day 1 ended up holding a
 * duplicate intro poster aimed at a date that had already been served.
 *
 * It is now event-driven. One day is "in flight" at a time, and the next day
 * only starts once the current one has actually resolved:
 *
 *   published  → advance (the fast path, from postPublisher)
 *   skipped    → advance (retries ran out of day, from postPublisher)
 *   declined   → advance (the user said no)
 *   stalled    → advance (hourly scheduler safety net, if an event was missed)
 *
 * Dates become consequences rather than promises, so nothing can drift.
 */
const logger = require("../core/logger");
const ContentPlan = require("../modules/poster/contentPlan.model");
const Business = require("../modules/business/business.model");
const BusinessOffers = require("../modules/plan/businessOffers.model");
const User = require("../modules/user/user.model");
const { PLANS } = require("../constants/plans");

// A day occupying any of these is still being worked on — only one at a time.
const IN_FLIGHT = ["prompt_ready", "in_queue", "generating", "ready", "approved"];
// Resolved one way or another; the chain may move past these.
const RESOLVED = ["posted", "declined", "skipped"];

// The free tier gets the two welcome posters (Intro, About Us) and stops.
// Everything past day 2 is a paid feature.
const FREE_PLAN_LAST_DAY = 2;

// Never schedule a post closer than this — it is the window the client has to
// look at the poster and decline it before it goes out.
const MIN_LEAD_MS = 2 * 60 * 60 * 1000;

// How long a queued-but-not-yet-started day is treated as in flight. Long
// enough to cover a busy worker, short enough that a job lost before it ever
// ran is retried on the next hourly check rather than sitting for ever.
const QUEUE_GRACE_MS = 15 * 60 * 1000;

const isInFlight = (day, now = Date.now()) =>
  IN_FLIGHT.includes(day.planStatus) ||
  Boolean(day.chainQueuedAt && now - new Date(day.chainQueuedAt).getTime() < QUEUE_GRACE_MS);
const isResolved = (day) => RESOLVED.includes(day.planStatus) || day.posted === true;

/**
 * Next occurrence of HH:MM that is at least MIN_LEAD_MS away.
 *
 * Publishing at 17:30 today means today's slot is gone, so the next poster
 * goes out tomorrow. Skipping a failed post at midnight means today's 17:30 is
 * still ~17 hours out, so the replacement goes out the same day — which is the
 * point: a failed post must not cost the client a day of posting.
 */
const nextPostSlot = (autoPostTime, from = new Date()) => {
  const [hour, minute] = String(autoPostTime || "12:00").split(":").map(Number);
  const slot = new Date(from);
  slot.setHours(hour, minute, 0, 0);
  if (slot.getTime() - from.getTime() < MIN_LEAD_MS) {
    slot.setDate(slot.getDate() + 1);
  }
  return slot;
};

/**
 * Whether this account is still entitled to the given day.
 * Returns a reason string when it is not, null when it is.
 */
const gateByPlan = async (userId, dayNumber) => {
  const user = await User.findById(userId).select("plan").lean();
  const plan = user?.plan || PLANS.BASIC;
  if (plan === PLANS.BASIC && dayNumber > FREE_PLAN_LAST_DAY) {
    return `free plan stops after day ${FREE_PLAN_LAST_DAY}`;
  }
  return null;
};

/**
 * Move the plan on to its next day and queue that day's prompt.
 *
 * Safe to call more than once for the same event: if a day is already in
 * flight it does nothing, which is what stops two accounts publishing the same
 * content (one Instagram, one Facebook) from advancing the chain twice.
 *
 * @param {object} opts
 * @param {string|object} opts.planId  ContentPlan id (or the doc itself)
 * @param {string} opts.reason         why the chain is advancing, for the log
 * @returns {Promise<{advanced: boolean, dayNumber?: number, reason?: string}>}
 */
const advanceChain = async ({ planId, reason = "unknown" }) => {
  const plan = typeof planId === "object" && planId?.days
    ? planId
    : await ContentPlan.findById(planId).lean();

  if (!plan) return { advanced: false, reason: "plan not found" };
  if (plan.status !== "active") return { advanced: false, reason: `plan is ${plan.status}` };

  // One in flight at a time. This is the guard that makes a double publish
  // event (Instagram then Facebook) harmless.
  const busy = plan.days.find(isInFlight);
  if (busy) {
    return { advanced: false, reason: `day ${busy.dayNumber} already in flight` };
  }

  const next = plan.days
    .filter((d) => !isResolved(d) && d.planStatus === "concept")
    .sort((a, b) => a.dayNumber - b.dayNumber)[0];

  if (!next) return { advanced: false, reason: "cycle complete" };

  const blocked = await gateByPlan(plan.userId, next.dayNumber);
  if (blocked) {
    logger.info("[planChain] not advancing", {
      planId: String(plan._id),
      dayNumber: next.dayNumber,
      reason: blocked,
    });
    return { advanced: false, reason: blocked };
  }

  const [business, offers] = await Promise.all([
    Business.findById(plan.businessId).select("autopilot").lean(),
    BusinessOffers.findOne({ businessId: plan.businessId }).select("autoPostTime").lean(),
  ]);

  // Auto-posting off means the plan should not queue itself at all, rather
  // than queueing work the publisher then has to refuse.
  if (business?.autopilot?.enabled === false) {
    return { advanced: false, reason: "autopilot disabled" };
  }

  const now = new Date();
  const postAt = nextPostSlot(offers?.autoPostTime, now);

  await ContentPlan.updateOne(
    { _id: plan._id, "days.dayNumber": next.dayNumber },
    {
      $set: {
        "days.$.scheduledGenerationAt": now,
        "days.$.scheduledPostAt": postAt,
        "days.$.declineDeadlineAt": new Date(postAt.getTime() - MIN_LEAD_MS),
        "days.$.chainQueuedAt": now,
      },
    }
  );

  // Queued, not generated inline: image generation is slow and must not hold
  // up the publish that triggered it.
  const { getQueues } = require("../queues/queues");
  await getQueues().posterPrompt.add(
    `chain-prompt-day${next.dayNumber}-${plan.businessId}`,
    { contentPlanId: String(plan._id), dayNumber: next.dayNumber },
    { jobId: `prompt-${plan._id}-day${next.dayNumber}` }
  );

  logger.info("[planChain] advanced", {
    planId: String(plan._id),
    dayNumber: next.dayNumber,
    reason,
    postAt: postAt.toISOString(),
  });

  return { advanced: true, dayNumber: next.dayNumber, postAt };
};

/**
 * Find the plan that owns a piece of content.
 */
const planForContent = async (contentId) =>
  ContentPlan.findOne({ "days.contentId": contentId }).lean();

module.exports = {
  advanceChain,
  planForContent,
  nextPostSlot,
  isInFlight,
  isResolved,
  IN_FLIGHT,
  RESOLVED,
  QUEUE_GRACE_MS,
  FREE_PLAN_LAST_DAY,
  MIN_LEAD_MS,
};
