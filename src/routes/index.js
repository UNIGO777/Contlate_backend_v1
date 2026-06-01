const express = require("express");
const ApiResponse = require("../core/ApiResponse");
const env = require("../config/env");
const authMiddleware = require("../middlewares/auth.middleware");
const authRoutes = require("../modules/auth/auth.routes");
const userRoutes = require("../modules/user/user.routes");
const businessRoutes = require("../modules/business/business.routes");
const contentRoutes = require("../modules/content/content.routes");
const socialRoutes = require("../modules/social/social.routes");
const subscriptionRoutes = require("../modules/subscription/subscription.routes");
const uploadRoutes = require("../modules/upload/upload.routes");
const usageRoutes = require("../modules/usage/usage.routes");
const scheduleRoutes = require("../modules/schedule/schedule.routes");
const dashboardRoutes = require("../modules/dashboard/dashboard.routes");
const posterRoutes = require("../modules/poster/poster.routes");
const productPosterRoutes = require("../modules/product-poster/productPoster.routes");
const adminRoutes = require("../modules/admin/admin.routes");
const notificationRoutes = require("../modules/notification/notification.routes");
const planRoutes = require("../modules/plan/plan.routes");
const publishRoutes = require("../modules/publish/publish.routes");

const router = express.Router();

router.get("/health", (_req, res) => {
  return res.status(200).json(
    new ApiResponse(
      200,
      {
        service: "postengine-backend",
        status: "ok",
        timestamp: new Date().toISOString(),
      },
      "Backend is healthy."
    )
  );
});

// Public — auth manages its own sub-route protection
router.use("/auth", authRoutes);

// Public — Google OAuth redirect: Google redirects here after approval/denial.
// The system browser on mobile can't pass auth headers, so this public route
// forwards the OAuth params to the app via deep link.
router.get("/business/gbp/callback", (req, res, next) => {
  // If Authorization header is present, this is an authenticated API call from the
  // frontend — let it fall through to the normal authenticated handler.
  if (req.headers.authorization) return next();

  // Direct browser redirect from Google — forward params to the app deep link
  // Production / dev build: MOBILE_DEEP_LINK_BASE=postengine:/
  // Expo Go testing:        MOBILE_DEEP_LINK_BASE=exp://192.168.1.4:8081/--
  const params = new URLSearchParams();
  ["code", "state", "error", "error_description"].forEach((key) => {
    if (req.query[key]) params.set(key, String(req.query[key]));
  });
  res.redirect(`${env.mobileDeepLinkBase}/gbp-callback?${params.toString()}`);
});

// Public — Meta OAuth redirect: Facebook/Instagram redirects here after approval/denial.
// Same pattern as GBP — system browser can't pass auth headers, so forward to deep link.
router.get("/social/oauth/meta/callback", (req, res, next) => {
  if (req.headers.authorization) return next();

  // Production / dev build: MOBILE_DEEP_LINK_BASE=postengine:/
  // Expo Go testing:        MOBILE_DEEP_LINK_BASE=exp://192.168.1.4:8081/--
  const params = new URLSearchParams();
  ["code", "state", "error", "error_description"].forEach((key) => {
    if (req.query[key]) params.set(key, String(req.query[key]));
  });
  res.redirect(`${env.mobileDeepLinkBase}/social-callback?${params.toString()}`);
});

// Public — Instagram OAuth redirect: Instagram redirects here after approval/denial.
// Same deep-link pattern as Meta — system browser can't pass auth headers.
router.get("/social/oauth/instagram/callback", (req, res, next) => {
  if (req.headers.authorization) return next();

  const params = new URLSearchParams();
  ["code", "state", "error", "error_description"].forEach((key) => {
    if (req.query[key]) params.set(key, String(req.query[key]));
  });
  params.set("provider", "instagram");
  res.redirect(`${env.mobileDeepLinkBase}/social-callback?${params.toString()}`);
});

// All routes below require a valid, non-suspended, non-deleted account
router.use(authMiddleware);
router.use("/users", userRoutes);
router.use("/business", businessRoutes);
router.use("/content", contentRoutes);
router.use("/social", socialRoutes);
router.use("/subscription", subscriptionRoutes);
router.use("/upload", uploadRoutes);
router.use("/usage", usageRoutes);
router.use("/schedule", scheduleRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/poster", posterRoutes);
router.use("/product-poster", productPosterRoutes);
router.use("/admin", adminRoutes);
router.use("/notifications", notificationRoutes);
router.use("/plan", planRoutes);
router.use("/publish", publishRoutes);

module.exports = router;
