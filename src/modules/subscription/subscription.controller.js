const ApiResponse = require("../../core/ApiResponse");
const asyncHandler = require("../../core/asyncHandler");
const subscriptionService = require("./subscription.service");
const env = require("../../config/env");

const getMySubscription = asyncHandler(async (req, res) => {
  const result = await subscriptionService.getSubscriptionByUserId(req.user.id);
  return res
    .status(200)
    .json(new ApiResponse(200, result, "Subscription fetched successfully."));
});

const updateMyPlan = asyncHandler(async (req, res) => {
  const result = await subscriptionService.changePlan(req.user.id, req.validated);
  return res.status(200).json(
    new ApiResponse(200, result, "Subscription updated. Use the returned token for future requests.")
  );
});

const cancelMySubscription = asyncHandler(async (req, res) => {
  const result = await subscriptionService.cancelSubscription(req.user.id);
  return res.status(200).json(
    new ApiResponse(200, result, "Subscription cancelled. Use the returned token for future requests.")
  );
});

const createCheckout = asyncHandler(async (req, res) => {
  // Derive base URLs from the request so the service doesn't need env knowledge
  const proto      = req.get("x-forwarded-proto") || (req.secure ? "https" : "http");
  const host       = req.get("host");
  const baseUrl    = env.adminPanelOrigin || `${proto}://${host}`;
  const callbackBaseUrl = `${proto}://${host}`;

  const result = await subscriptionService.createCheckout(
    req.user.id,
    req.validated,
    { baseUrl, callbackBaseUrl }
  );
  return res.status(200).json(new ApiResponse(200, result, "Checkout session created."));
});

module.exports = {
  getMySubscription,
  updateMyPlan,
  cancelMySubscription,
  createCheckout,
};
