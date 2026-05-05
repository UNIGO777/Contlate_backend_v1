const env = require("../config/env");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const isProd = env.nodeEnv === "production";

const write = (level, message, meta) => {
  const timestamp = new Date().toISOString();

  if (isProd) {
    const line = {
      timestamp,
      level,
      message,
      ...(meta && typeof meta === "object" ? { meta } : {}),
    };
    const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
    out.write(`${JSON.stringify(line)}\n`);
    return;
  }

  const prefix = `[${timestamp}] ${level.toUpperCase()}:`;
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`${prefix} ${message}${suffix}`);
};

const logger = {
  debug(message, meta) {
    write("debug", message, meta);
  },
  info(message, meta) {
    write("info", message, meta);
  },
  warn(message, meta) {
    write("warn", message, meta);
  },
  error(message, meta) {
    write("error", message, meta);
  },
};

logger.LEVELS = LEVELS;

module.exports = logger;
