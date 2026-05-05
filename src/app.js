const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const env = require("./config/env");
const ApiError = require("./core/ApiError");
const { ERROR_CODES } = require("./constants/errorCodes");
const apiRateLimiter = require("./middlewares/rateLimit.middleware");
const errorMiddleware = require("./middlewares/error.middleware");
const routes = require("./routes");
const staticRoutes = require("./modules/upload/upload.static.routes");
const webhookRoutes = require("./modules/subscription/webhook.routes");

const app = express();

app.set("trust proxy", 1);

app.use(
  cors({
    origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(","),
    credentials: true,
  })
);
app.use(helmet());
app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev"));
// Local storage ingest/serve routes (bypass JSON parser; bound to raw body per-route).
app.use("/static", staticRoutes);
// Webhooks must read the raw body for signature verification — mount before JSON parser.
app.use(`${env.apiPrefix}/webhooks`, webhookRoutes);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(apiRateLimiter);

app.get("/", (_req, res) => {
  return res.status(200).json({
    success: true,
    message: "PostEngine backend is running.",
  });
});

app.use(env.apiPrefix, routes);
app.use((_req, _res, next) =>
  next(new ApiError(404, "Route not found.", { code: ERROR_CODES.ROUTE_NOT_FOUND }))
);
app.use(errorMiddleware);

module.exports = app;
