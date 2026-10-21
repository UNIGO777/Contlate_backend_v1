const app = require("./app");
const env = require("./config/env");
const { connectDb } = require("./config/db");
const { seedAdmin } = require("./config/seedAdmin");
const logger = require("./core/logger");
const { initSocket } = require("./core/socket");
const subscriptionSyncJob = require("./jobs/subscriptionSync.job");
const postPublisherJob = require("./jobs/postPublisher.job");
const seoRefreshJob = require("./jobs/seoRefresh.job");
const tokenRefreshJob = require("./jobs/tokenRefresh.job");
const gbpDailyPostJob = require("./jobs/gbpDailyPost.job");
const accountHealthCheckJob = require("./jobs/accountHealthCheck.job");
const reviewAutoReplyJob = require("./jobs/reviewAutoReply.job");
const renewalReminderJob = require("./jobs/renewalReminder.job");

/**
 * Probe Redis before starting queue workers.
 * Returns true if Redis responds to PING within 3 seconds.
 */
const probeRedis = async () => {
  const IORedis = require("ioredis");
  const client = new IORedis({
    host: env.redis.host,
    port: env.redis.port,
    password: env.redis.password || undefined,
    db: env.redis.db,
    connectTimeout: 3000,
    retryStrategy: () => null, // no retries — one shot
    lazyConnect: true,
  });

  // Swallow errors during probe so they don't print to stderr
  client.on("error", () => {});

  try {
    await client.connect();
    await client.ping();
    await client.quit();
    return true;
  } catch {
    client.disconnect();
    return false;
  }
};

const startServer = async () => {
  try {
    await connectDb();
    await seedAdmin();

    // Existing jobs (MongoDB-based, always start)
    subscriptionSyncJob.start();
    postPublisherJob.start();
    seoRefreshJob.start();
    tokenRefreshJob.start();
    gbpDailyPostJob.start();
    accountHealthCheckJob.start();
    reviewAutoReplyJob.start();
    renewalReminderJob.start();

    // BullMQ queue workers — only start if Redis is reachable
    const redisOk = await probeRedis();
    if (redisOk) {
      try {
        const contentPlanWorker = require("./queues/workers/contentPlan.worker");
        const posterPromptWorker = require("./queues/workers/posterPrompt.worker");
        const posterImageWorker = require("./queues/workers/posterImage.worker");
        const welcomePosterWorker = require("./queues/workers/welcomePoster.worker");
        const posterCleanupWorker = require("./queues/workers/posterCleanup.worker");
        const gbpSyncWorker = require("./queues/workers/gbpSync.worker");
        const posterScheduler = require("./queues/scheduler");

        contentPlanWorker.start();
        posterPromptWorker.start();
        posterImageWorker.start();
        welcomePosterWorker.start();
        posterCleanupWorker.start();
        gbpSyncWorker.start();
        posterScheduler.start();
        logger.info("Queue workers + scheduler started (Redis connected)");
      } catch (queueErr) {
        logger.warn("Poster queue workers failed to start", { message: queueErr.message });
      }
    } else {
      logger.info("Redis not available — poster pipeline disabled. Start Redis to enable poster generation.");
    }

    const httpServer = app.listen(env.port, () => {
      logger.info(`Server listening on port ${env.port}`);
      // Whether the testing escape hatch is live is otherwise invisible, and
      // "did the .env actually load?" is the first question when a cap still
      // fires after setting it.
      if (env.relaxPlanLimits) {
        logger.warn("RELAX_PLAN_LIMITS is ON — all per-plan daily caps are disabled");
      } else {
        logger.info("Plan limits enforced (RELAX_PLAN_LIMITS is off)");
      }
    });
    initSocket(httpServer);
  } catch (error) {
    logger.error("Failed to start server", {
      message: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
};

startServer();
