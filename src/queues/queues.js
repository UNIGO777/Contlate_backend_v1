const { Queue } = require("bullmq");
const { getConnection } = require("./connection");

const QUEUE_NAMES = Object.freeze({
  CONTENT_PLAN: "content-plan",
  POSTER_PROMPT: "poster-prompt",
  POSTER_IMAGE: "poster-image",
  WELCOME_POSTER: "welcome-poster",
  POSTER_CLEANUP: "poster-cleanup",
  GBP_SYNC: "gbp-sync",
});

let queues = null;

const getQueues = () => {
  if (queues) return queues;

  const connection = getConnection();

  queues = {
    contentPlan: new Queue(QUEUE_NAMES.CONTENT_PLAN, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    }),

    posterPrompt: new Queue(QUEUE_NAMES.POSTER_PROMPT, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 15_000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 2000 },
      },
    }),

    posterImage: new Queue(QUEUE_NAMES.POSTER_IMAGE, {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    }),

    welcomePoster: new Queue(QUEUE_NAMES.WELCOME_POSTER, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    }),

    posterCleanup: new Queue(QUEUE_NAMES.POSTER_CLEANUP, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 2000 },
        removeOnFail: { count: 1000 },
      },
    }),

    gbpSync: new Queue(QUEUE_NAMES.GBP_SYNC, {
      connection,
      defaultJobOptions: {
        attempts: 4,
        backoff: { type: "exponential", delay: 30_000 }, // 30s, 60s, 120s, 240s (~7.5 min total)
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    }),
  };

  return queues;
};

module.exports = { QUEUE_NAMES, getQueues };
