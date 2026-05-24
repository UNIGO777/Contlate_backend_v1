const express = require("express");
const authMiddleware = require("../../middlewares/auth.middleware");
const checkBusinessMiddleware = require("../../middlewares/checkBusiness.middleware");
const validateMiddleware = require("../../middlewares/validate.middleware");
const socialController = require("./social.controller");
const oauthController = require("./oauth.controller");
const metaController = require("./meta.controller");
const {
  validateSocialAccountPayload,
  validateSocialAccountUpdatePayload,
} = require("./social.validation");

const router = express.Router();

// Unauthenticated: Meta browser-redirect callback (kept for server-side OAuth compat)
router.get("/oauth/meta/callback", oauthController.completeMetaOAuth);

router.use(authMiddleware);

// ── Meta OAuth ───────────────────────────────────────────────────────────────
// OAuth start runs before checkBusiness so the user can hit it with just an account.
router.get("/oauth/meta/start", oauthController.startMetaOAuth);
// Mobile-friendly exchange: WebView intercepts callback, frontend calls this with code+state
router.post("/oauth/meta/exchange", oauthController.exchangeMetaOAuth);

// ── LinkedIn OAuth ────────────────────────────────────────────────────────────
router.get("/oauth/linkedin/start", oauthController.startLinkedInOAuth);
router.post("/oauth/linkedin/exchange", oauthController.exchangeLinkedInOAuth);

router.use(checkBusinessMiddleware);

// ── Meta Account Management ───────────────────────────────────────────────────
router.get("/meta/connection-status", metaController.getConnectionStatus);
router.get("/meta/pages", metaController.listPages);
router.post("/meta/select-pages", metaController.selectPages);
router.get("/meta/instagram-status/:pageId", metaController.getInstagramStatus);
router.get("/meta/permissions", metaController.checkPermissions);
router.post("/meta/refresh-token/:socialAccountId", metaController.refreshToken);
router.post("/meta/reconnect/:socialAccountId", metaController.reconnect);
router.post("/meta/refresh-connection", metaController.refreshConnection);

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
