const { CONNECTION_STATES } = require("./connectionStates");

const CONNECTION_MESSAGES = Object.freeze({
  [CONNECTION_STATES.NO_FACEBOOK_LOGIN]: {
    title: "Connect with Facebook",
    description: "Connect to manage your Facebook Pages and Instagram accounts.",
    actionLabel: "Connect with Facebook",
    actionType: "OAUTH",
  },
  [CONNECTION_STATES.TOKEN_EXPIRED]: {
    title: "Connection Expired",
    description: "Your Facebook connection needs to be renewed.",
    actionLabel: "Reconnect",
    actionType: "REAUTH",
  },
  [CONNECTION_STATES.NO_PAGE]: {
    title: "Create a Facebook Page",
    description: "A Facebook Page is required to publish content.",
    actionLabel: "Create Facebook Page",
    actionType: "EXTERNAL_LINK",
    actionUrl: "https://www.facebook.com/pages/creation/",
    secondaryAction: { label: "I've Created a Page", actionType: "REFRESH" },
  },
  [CONNECTION_STATES.PAGE_EXISTS_NO_IG]: {
    title: "Connect Instagram",
    description:
      "To publish on Instagram, link your account to your Facebook Page.",
    actionLabel: "Link Instagram",
    actionType: "EXTERNAL_LINK",
    secondaryAction: { label: "I've Connected It", actionType: "REFRESH" },
  },
  [CONNECTION_STATES.IG_PERSONAL]: {
    title: "Switch to a Professional Instagram Account",
    description:
      "A Professional account (Business or Creator) is required for Instagram publishing.",
    actionLabel: "How to Convert",
    actionType: "GUIDE",
    steps: [
      "Open the Instagram app",
      "Go to Settings > Account > Switch to Professional Account",
      "Choose Business or Creator",
      "Select a category",
      "Come back and click Refresh when done",
    ],
    secondaryAction: { label: "I've Converted It", actionType: "REFRESH" },
  },
  [CONNECTION_STATES.PERMISSIONS_MISSING]: {
    title: "Additional Permissions Required",
    description: "Some extra permissions are needed to publish content.",
    actionLabel: "Grant Permissions",
    actionType: "REAUTH",
  },
  [CONNECTION_STATES.READY_TO_PUBLISH]: {
    title: "All Set!",
    description: "You are ready to publish content.",
    actionLabel: null,
    actionType: null,
  },
  [CONNECTION_STATES.RATE_LIMITED]: {
    title: "Try Again in a Moment",
    description:
      "Could not connect to Facebook right now. Please try again in a few minutes.",
    actionLabel: "Retry",
    actionType: "REFRESH",
  },
  [CONNECTION_STATES.DETECTION_ERROR]: {
    title: "Something Went Wrong",
    description:
      "We could not check your connection status. Please try again.",
    actionLabel: "Retry",
    actionType: "REFRESH",
  },
});

module.exports = { CONNECTION_MESSAGES };
