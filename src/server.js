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
const accountHealthCheckJob = require("./jobs/accountHealthCheck.job");

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
    accountHealthCheckJob.start();

    // BullMQ queue workers — only start if Redis is reachable
    const redisOk = await probeRedis();
    if (redisOk) {
      try {
        const contentPlanWorker = require("./queues/workers/contentPlan.worker");
        const posterPromptWorker = require("./queues/workers/posterPrompt.worker");
        const posterImageWorker = require("./queues/workers/posterImage.worker");
        const welcomePosterWorker = require("./queues/workers/welcomePoster.worker");
        const posterCleanupWorker = require("./queues/workers/posterCleanup.worker");
        const posterScheduler = require("./queues/scheduler");

        contentPlanWorker.start();
        posterPromptWorker.start();
        posterImageWorker.start();
        welcomePosterWorker.start();
        posterCleanupWorker.start();
        posterScheduler.start();
        logger.info("Poster queue workers + scheduler started (Redis connected)");
      } catch (queueErr) {
        logger.warn("Poster queue workers failed to start", { message: queueErr.message });
      }
    } else {
      logger.info("Redis not available — poster pipeline disabled. Start Redis to enable poster generation.");
    }

    const httpServer = app.listen(env.port, () => {
      logger.info(`Server listening on port ${env.port}`);
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
