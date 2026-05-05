const express = require("express");
const authMiddleware = require("../../middlewares/auth.middleware");
const checkBusinessMiddleware = require("../../middlewares/checkBusiness.middleware");
const validateMiddleware = require("../../middlewares/validate.middleware");
const socialController = require("./social.controller");
const oauthController = require("./oauth.controller");
const {
  validateSocialAccountPayload,
  validateSocialAccountUpdatePayload,
} = require("./social.validation");

const router = express.Router();

// OAuth callback is unauthenticated by design (Meta redirects the user's browser
// here with a signed `state` token that we verify in the controller).
router.get("/oauth/meta/callback", oauthController.completeMetaOAuth);

router.use(authMiddleware);

// OAuth start runs before checkBusiness so the user can hit it with just an account.
router.get("/oauth/meta/start", oauthController.startMetaOAuth);

router.use(checkBusinessMiddleware);

router.post("/", validateMiddleware(validateSocialAccountPayload), socialController.connectSocialAccount);
router.get("/", socialController.listMySocialAccounts);
router.get("/:socialAccountId", socialController.getMySocialAccountById);
router.patch(
  "/:socialAccountId",
  validateMiddleware(validateSocialAccountUpdatePayload),
  socialController.updateMySocialAccount
);
router.post("/:socialAccountId/disconnect", socialController.disconnectMySocialAccount);

module.exports = router;
