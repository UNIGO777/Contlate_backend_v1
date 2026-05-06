const logger = require("../core/logger");

/**
 * Request / response logger middleware.
 *
 * Logs two lines per request:
 *   →  incoming  — method, path, IP, user-agent
 *   ←  outgoing  — status, method, path, duration, userId (when authenticated)
 *
 * Severity matches HTTP status:
 *   2xx / 3xx  → info
 *   4xx        → warn
 *   5xx        → error   (details already captured by errorMiddleware)
 */
const requestLogger = (req, res, next) => {
  const startedAt = Date.now();

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "-";

  // ── Incoming ────────────────────────────────────────────────────────────
  logger.info(`→ ${req.method} ${req.originalUrl}`, {
    ip,
    userAgent: req.headers["user-agent"] ?? "-",
  });

  // ── Outgoing — fires once headers are sent ───────────────────────────────
  res.on("finish", () => {
    const ms = Date.now() - startedAt;
    const status = res.statusCode;
    const userId = req.user?._id?.toString() ?? req.user?.id ?? null;

    const meta = {
      status,
      ms,
      ...(userId ? { userId } : {}),
    };

    const line = `← ${req.method} ${req.originalUrl} ${status} (${ms}ms)`;

    if (status >= 500) {
      logger.error(line, meta);
    } else if (status >= 400) {
      logger.warn(line, meta);
    } else {
      logger.info(line, meta);
    }
  });

  // ── Client disconnected before response completed ────────────────────────
  res.on("close", () => {
    if (!res.writableEnded) {
      const ms = Date.now() - startedAt;
      logger.warn(`⚡ ${req.method} ${req.originalUrl} — client disconnected (${ms}ms)`, {
        ip,
      });
    }
  });

  next();
};

module.exports = requestLogger;
