const IORedis = require("ioredis");
const env = require("../config/env");
const logger = require("../core/logger");

let connection = null;
let logged = false; // only log the first error, not every retry

const getConnection = () => {
  if (connection) return connection;

  const opts = {
    host: env.redis.host,
    port: env.redis.port,
    db: env.redis.db,
    maxRetriesPerRequest: null, // required by BullMQ
    retryStrategy(times) {
      // Back off: 1s, 2s, 4s, 8s ... cap at 30s
      // Return null after 20 attempts to stop retrying
      if (times > 20) return null;
      return Math.min(times * 1000, 30_000);
    },
    // Don't connect immediately — let BullMQ trigger it
    lazyConnect: false,
    // Suppress built-in console error output on ECONNREFUSED
    showFriendlyErrorStack: false,
  };
  if (env.redis.password) opts.password = env.redis.password;

  connection = new IORedis(opts);

  connection.on("connect", () => {
    logged = false;
    logger.info("[redis] connected");
  });

  connection.on("error", (err) => {
    // Only log once to avoid spamming — IORedis fires this on every retry
    if (!logged) {
      logged = true;
      logger.warn("[redis] unavailable — poster queue workers disabled until Redis is running", {
        message: err.message,
      });
    }
  });

  return connection;
};

module.exports = { getConnection };
