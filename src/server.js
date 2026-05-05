const app = require("./app");
const env = require("./config/env");
const { connectDb } = require("./config/db");
const { seedAdmin } = require("./config/seedAdmin");
const logger = require("./core/logger");
const subscriptionSyncJob = require("./jobs/subscriptionSync.job");
const postPublisherJob = require("./jobs/postPublisher.job");

const startServer = async () => {
  try {
    await connectDb();
    await seedAdmin();

    subscriptionSyncJob.start();
    postPublisherJob.start();

    app.listen(env.port, () => {
      logger.info(`Server listening on port ${env.port}`);
    });
  } catch (error) {
    logger.error("Failed to start server", {
      message: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
};

startServer();
