/**
 * One-off migration for Nxtgendigitals' 28-day content plan.
 *
 * Days 1 (Intro) and 2 (About Us) were already published to Instagram on
 * 16 Oct as welcome posters, but the plan still had Day 1 pointing at a
 * second, duplicate intro poster scheduled to go out on 20 Oct 17:30.
 *
 * This marks both days done, cancels the duplicate schedule, and pulls
 * days 3-28 back by one day so Day 3 takes the next free slot instead of
 * leaving two blank days.
 *
 * Usage:  node scripts/shift-plan-to-day3.js           (dry run)
 *         node scripts/shift-plan-to-day3.js --apply   (writes)
 */
require("dotenv").config();
const { MongoClient, ObjectId } = require("mongodb");

const URI = process.env.MONGODB_URI;
if (!URI) {
  console.error("MONGODB_URI is not set — run this from the backend root with its .env in place.");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const IST = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "—";
const DAY = 24 * 60 * 60 * 1000;
const back1 = (d) => (d ? new Date(new Date(d).getTime() - DAY) : null);

const PLAN_ID = new ObjectId("6ad53b4cbf56cdd0d83c9377");
const DUP_SCHEDULE = new ObjectId("6ad56aafb12dc0300eba0236");
// Timestamps of the real publishes, taken from publishlogs.
const INTRO_POSTED_AT = new Date("2026-10-16T13:53:19.237Z");
const ABOUTUS_POSTED_AT = new Date("2026-10-16T13:53:30.091Z");

(async () => {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db();

  const plan = await db.collection("contentplans").findOne({ _id: PLAN_ID });
  if (!plan) throw new Error("content plan not found");

  console.log(APPLY ? "*** APPLYING ***" : "*** DRY RUN ***");
  console.log("now:", IST(new Date()), "\n");

  const days = plan.days.map((d) => {
    const o = { ...d };
    if (d.dayNumber === 1) {
      o.planStatus = "posted";
      o.posted = true;
      o.postedAt = INTRO_POSTED_AT;
    } else if (d.dayNumber === 2) {
      o.posted = true;
      o.postedAt = d.postedAt || ABOUTUS_POSTED_AT;
    } else {
      o.date = back1(d.date);
      o.scheduledGenerationAt = back1(d.scheduledGenerationAt);
      o.scheduledPostAt = back1(d.scheduledPostAt);
      o.declineDeadlineAt = back1(d.declineDeadlineAt);
    }
    return o;
  });

  console.log("day | status | generate | post | note");
  days.slice(0, 6).concat(days.slice(26)).forEach((d) => {
    const old = plan.days.find((x) => x.dayNumber === d.dayNumber);
    console.log(
      [
        d.dayNumber,
        d.planStatus,
        IST(d.scheduledGenerationAt),
        IST(d.scheduledPostAt),
        d.dayNumber <= 2 ? "marked posted" : `(was ${IST(old.scheduledPostAt)})`,
      ].join(" | ")
    );
  });

  const sched = await db.collection("schedules").findOne({ _id: DUP_SCHEDULE });
  console.log(
    "\nduplicate-intro schedule:",
    sched ? sched.status : "(gone)",
    "| due",
    IST(sched && sched.scheduledAt),
    "→ will become: cancelled"
  );

  if (!APPLY) {
    console.log("\n(no writes made — rerun with --apply)");
    return client.close();
  }

  const r1 = await db.collection("contentplans").updateOne({ _id: PLAN_ID }, { $set: { days } });
  const r2 = await db.collection("schedules").updateOne(
    { _id: DUP_SCHEDULE, status: "pending" },
    {
      $set: {
        status: "cancelled",
        lastError: "Superseded — intro poster already published 16 Oct",
        updatedAt: new Date(),
      },
    }
  );
  console.log("\nplan updated:", r1.modifiedCount, "| schedule cancelled:", r2.modifiedCount);
  await client.close();
})().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
