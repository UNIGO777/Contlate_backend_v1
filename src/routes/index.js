const express = require("express");
const ApiResponse = require("../core/ApiResponse");
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
const adminRoutes = require("../modules/admin/admin.routes");

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
router.use("/admin", adminRoutes);

module.exports = router;
