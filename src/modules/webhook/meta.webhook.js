const express = require("express");
const crypto = require("crypto");
const logger = require("../../core/logger");
const env = require("../../config/env");
const { SOCIAL_PLATFORMS } = require("../../constants/socialPlatforms");
const { SOCIAL_ACCOUNT_STATUS } = require("../../constants/socialAccountStatus");
const SocialAccount = require("../social/social.model");
const User = require("../user/user.model");
const Schedule = require("../schedule/schedule.model");
const WebhookEvent = require("./webhookEvent.model");
const { SCHEDULE_STATUS } = require("../../constants/scheduleStatus");
const { sendAppNotification } = require("../../utils/notifications");
const metaService = require("../../services/meta.service");

const router = express.Router();

/**
 * Cancel all pending/processing schedules for the given social account IDs.
 * Called when accounts are disconnected/deauthorized so orphaned schedules
 * don't keep failing.
 */
const cancelPendingSchedules = async (accountIds) => {
  if (!accountIds.length) return;
  const result = await Schedule.updateMany(
    {
      socialAccountId: { $in: accountIds },
      status: { $in: [SCHEDULE_STATUS.PENDING, SCHEDULE_STATUS.PROCESSING, SCHEDULE_STATUS.PAUSED] },
    },
    { $set: { status: SCHEDULE_STATUS.CANCELLED, lastError: "Account disconnected" } }
  );
  if (result.modifiedCount) {
    logger.info("[meta.webhook] cancelled pending schedules", {
      count: result.modifiedCount,
      accountIds: accountIds.map(String),
    });
  }
};

/**
 * Verify that a POST body was signed by Meta using our app secret.
 * Meta sends: X-Hub-Signature-256: sha256=<hex>
 */
const verifyMetaSignature = (rawBody, signature) => {
  if (!signature || !env.meta.appSecret) return false;
  const expected = "sha256=" +
    crypto
      .createHmac("sha256", env.meta.appSecret)
      .update(rawBody)
      .digest("hex");
  // Timing-safe compare to prevent timing attacks
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
};

// ── GET /webhooks/meta ────────────────────────────────────────────────────────
// Meta sends a challenge request when you first subscribe.
// We must return hub.challenge if hub.verify_token matches our secret.
router.get("/", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === env.meta.webhookVerifyToken) {
    logger.info("[meta.webhook] verification challenge accepted");
    return res.status(200).send(challenge);
  }

  logger.warn("[meta.webhook] verification failed", { mode, token });
  return res.status(403).send("Forbidden");
});

// ── POST /webhooks/meta ───────────────────────────────────────────────────────
// Meta sends signed callbacks for:
//   - User removes your app (deauthorize) → object: "user", changes[].field: "feed"
//   - Permissions change (data_deletion_request)
//   - Page-level deauthorization
router.post(
  "/",
  express.raw({ type: "application/json", limit: "512kb" }),
  async (req, res) => {
    // Always respond 200 immediately — Meta will retry if we don't
    res.status(200).json({ received: true });

    const rawBody  = req.body instanceof Buffer ? req.body.toString("utf8") : "";
    const signature = req.get("x-hub-signature-256") || "";

    if (!verifyMetaSignature(rawBody, signature)) {
      logger.warn("[meta.webhook] signature mismatch — ignoring payload");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      logger.warn("[meta.webhook] invalid JSON body");
      return;
    }

    logger.info("[meta.webhook] received", {
      object: payload.object,
      entries: payload.entry?.length ?? 0,
    });

    // Process each entry async (errors are caught per-entry)
    const entries = payload.entry || [];
    for (const entry of entries) {
      const eventId = crypto.randomUUID();
      try {
        // Deduplicate by entryId — skip if we already processed this entry recently
        if (entry.id) {
          const recent = await WebhookEvent.findOne({
            entryId: String(entry.id),
            object: payload.object,
            status: "processed",
            receivedAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
          }).lean();
          if (recent) {
            logger.info("[meta.webhook] duplicate entry skipped", { entryId: entry.id });
            continue;
          }
        }

        await WebhookEvent.create({
          eventId,
          object: payload.object,
          entryId: entry.id ? String(entry.id) : "",
          status: "processing",
          rawPayload: entry,
          receivedAt: new Date(),
        });

        const action = await handleEntry(payload.object, entry);

        await WebhookEvent.findOneAndUpdate(
          { eventId },
          { $set: { status: "processed", processedAt: new Date(), action: action || "" } }
        );
      } catch (err) {
        logger.error("[meta.webhook] entry handling failed", {
          entryId: entry.id,
          message: err.message,
        });
        WebhookEvent.findOneAndUpdate(
          { eventId },
          { $set: { status: "failed", errorMessage: err.message?.slice(0, 500) || "" } }
        ).catch(() => {});
      }
    }
  }
);

/**
 * Handle a single webhook entry from Meta.
 */
const handleEntry = async (object, entry) => {
  // ── User deauthorized the app ───────────────────────────────────────────────
  // payload.object = "user" or "page"
  // entry.uid (for user object) = Meta user ID
  if (object === "user" && entry.uid) {
    await handleUserDeauthorization(entry.uid);
    return "user_deauthorized";
  }

  // ── Page-level changes ──────────────────────────────────────────────────────
  if (object === "page" && entry.id) {
    const changes = entry.changes || [];
    let action = "ignored";
    for (const change of changes) {
      if (change.field === "feed") {
        await handlePageDeauthorization(entry.id);
        action = "page_deauthorized";
      } else if (change.field === "access") {
        await handlePageAccessChanged(entry.id);
        action = "page_access_changed";
      } else if (change.field === "name" || change.field === "picture") {
        await handlePageMetadataChange(entry.id, change.field, change.value);
        action = action === "ignored" ? "page_metadata_updated" : action;
      }
    }
    return action;
  }

  // ── Permissions-changed callback ────────────────────────────────────────────
  if (object === "permissions" && entry.uid) {
    await handlePermissionsRevoked(entry.uid);
    return "permissions_revoked";
  }

  return "ignored";
};

/**
 * When a user removes the app from their Facebook settings, mark all their
 * connected Meta accounts as expired.
 *
 * Note: entry.uid is the Meta *user* ID, not our internal userId.
 * We have to match it against stored account data. Since we don't store the
 * Meta user ID directly, we use the signed_request payload or match by accountId
 * on our Facebook/Instagram records.
 *
 * Meta sends signed_request for data_deletion_request as a form POST, but for
 * deauthorize callbacks it sends the uid directly. We match by any FB/IG account
 * whose accountId or pageId equals the uid.
 */
const handleUserDeauthorization = async (metaUserId) => {
  logger.info("[meta.webhook] user deauthorize", { metaUserId });

  // Find accounts whose accountId or pageId matches the deauthorizing user/page
  const accounts = await SocialAccount.find({
    platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
    status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
    $or: [
      { accountId: metaUserId },
      { pageId: metaUserId },
    ],
  });

  for (const account of accounts) {
    await SocialAccount.findByIdAndUpdate(account._id, {
      $set: {
        status: SOCIAL_ACCOUNT_STATUS.DISCONNECTED,
        accessToken: "",
        userAccessToken: "",
        healthStatus: "critical",
        disconnectReason: "user_deauthorized",
      },
    });

    notifyWithEmail(account, "ACCOUNT_DISCONNECTED", { reason: "Meta user deauthorization" });
  }

  if (accounts.length) {
    await cancelPendingSchedules(accounts.map((a) => a._id));
    // Invalidate state cache for all affected users
    const userIds = [...new Set(accounts.map((a) => a.userId.toString()))];
    for (const uid of userIds) {
      metaService.invalidateStateCache(uid);
    }
    logger.info("[meta.webhook] deauthorized accounts", { count: accounts.length, metaUserId });
  }
};

/**
 * When a specific Facebook Page removes or loses access, mark that page's
 * FB and IG accounts as expired.
 */
const handlePageDeauthorization = async (pageId) => {
  logger.info("[meta.webhook] page deauthorize", { pageId });

  const accounts = await SocialAccount.find({
    platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
    status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
    $or: [{ accountId: pageId }, { pageId }],
  });

  for (const account of accounts) {
    await SocialAccount.findByIdAndUpdate(account._id, {
      $set: {
        status: SOCIAL_ACCOUNT_STATUS.DISCONNECTED,
        accessToken: "",
        userAccessToken: "",
        healthStatus: "critical",
        disconnectReason: "page_deauthorized",
      },
    });

    const notifData = { platform: account.platform, accountName: account.accountName };
    User.findById(account.userId).lean().then((user) => {
      const opts = user ? { userEmail: user.email, userName: user.name } : {};
      sendAppNotification(account.userId, "ACCOUNT_DISCONNECTED", notifData, opts);
    }).catch(() => {
      sendAppNotification(account.userId, "ACCOUNT_DISCONNECTED", notifData);
    });
  }

  if (accounts.length) {
    await cancelPendingSchedules(accounts.map((a) => a._id));
    const userIds = [...new Set(accounts.map((a) => a.userId.toString()))];
    for (const uid of userIds) {
      metaService.invalidateStateCache(uid);
    }
    logger.info("[meta.webhook] page deauthorized accounts", { count: accounts.length, pageId });
  }
};

/**
 * When a page's access level changes (e.g., admin role revoked), verify
 * whether the user can still publish and update account status accordingly.
 *
 * Unlike full deauthorization, access changes may be partial — the user may
 * still have read access but lose publishing rights. We try to verify via
 * the stored token and fall back to marking as "warning" if verification fails.
 */
const handlePageAccessChanged = async (pageId) => {
  logger.info("[meta.webhook] page access changed", { pageId });

  const accounts = await SocialAccount.find({
    platform: SOCIAL_PLATFORMS.FACEBOOK,
    status: SOCIAL_ACCOUNT_STATUS.CONNECTED,
    $or: [{ accountId: pageId }, { pageId }],
  });

  if (!accounts.length) return;

  for (const account of accounts) {
    // Try to verify access using stored token
    const rawToken = account.userAccessToken || account.accessToken;
    if (!rawToken) {
      // No token to verify — mark as disconnected
      await SocialAccount.findByIdAndUpdate(account._id, {
        $set: {
          status: SOCIAL_ACCOUNT_STATUS.DISCONNECTED,
          healthStatus: "critical",
          disconnectReason: "page_access_lost",
        },
      });
      notifyWithEmail(account, "ACCOUNT_DISCONNECTED", {
        platform: account.platform,
        accountName: account.accountName,
        reason: `Your admin access to '${account.accountName}' has been removed.`,
      });
      continue;
    }

    let token;
    try {
      token = metaService.decryptToken(rawToken);
    } catch {
      // Can't decrypt — treat as access lost
      await SocialAccount.findByIdAndUpdate(account._id, {
        $set: {
          status: SOCIAL_ACCOUNT_STATUS.DISCONNECTED,
          healthStatus: "critical",
          disconnectReason: "page_access_lost",
        },
      });
      continue;
    }

    // Check if the page still appears in the user's managed pages
    try {
      const pages = await metaService.listManagedPages(token);
      const myPage = pages.find((p) => p.pageId === account.accountId);

      if (!myPage) {
        // Page no longer in user's account — full disconnect
        await SocialAccount.findByIdAndUpdate(account._id, {
          $set: {
            status: SOCIAL_ACCOUNT_STATUS.DISCONNECTED,
            healthStatus: "critical",
            disconnectReason: "page_access_lost",
          },
        });

        // Also disconnect linked IG
        await SocialAccount.updateMany(
          {
            userId: account.userId,
            platform: SOCIAL_PLATFORMS.INSTAGRAM,
            pageId: account.pageId,
            status: { $ne: SOCIAL_ACCOUNT_STATUS.DISCONNECTED },
          },
          {
            $set: {
              status: SOCIAL_ACCOUNT_STATUS.DISCONNECTED,
              healthStatus: "critical",
              disconnectReason: "page_access_lost",
            },
          }
        );

        await cancelPendingSchedules([account._id]);

        notifyWithEmail(account, "ACCOUNT_DISCONNECTED", {
          platform: account.platform,
          accountName: account.accountName,
          reason: `Your admin access to '${account.accountName}' has been removed.`,
        });
      } else if (!myPage.canPublish) {
        // User still has the page but can't publish (e.g., Analyst role)
        await SocialAccount.findByIdAndUpdate(account._id, {
          $set: {
            healthStatus: "warning",
            setupIssues: ["page_access_lost"],
          },
        });

        notifyWithEmail(account, "SOCIAL_ACCOUNT_EXPIRED", {
          platform: account.platform,
          accountName: account.accountName,
          reason: `Your publishing permissions on '${account.accountName}' have changed. You may need to request admin access.`,
        });
      }
      // else: user still has full access — no action needed
    } catch (err) {
      // Verification failed (rate limit, network) — mark as warning, let health check verify later
      logger.warn("[meta.webhook] page access verification failed", {
        pageId,
        accountId: account._id.toString(),
        message: err.message,
      });

      await SocialAccount.findByIdAndUpdate(account._id, {
        $set: {
          healthStatus: "warning",
          setupIssues: ["page_access_lost"],
        },
      });
    }
  }

  // Invalidate state cache for all affected users
  const userIds = [...new Set(accounts.map((a) => a.userId.toString()))];
  for (const uid of userIds) {
    metaService.invalidateStateCache(uid);
  }
};

/**
 * Send a notification with email support (fire-and-forget helper).
 */
const notifyWithEmail = (account, type, data) => {
  const notifData = { platform: account.platform, accountName: account.accountName, ...data };
  User.findById(account.userId).lean().then((user) => {
    const opts = user ? { userEmail: user.email, userName: user.name } : {};
    sendAppNotification(account.userId, type, notifData, opts);
  }).catch(() => {
    sendAppNotification(account.userId, type, notifData);
  });
};

/**
 * When Meta sends a permissions-changed event, mark affected accounts as expired
 * and notify users to re-grant permissions.
 */
const handlePermissionsRevoked = async (metaUserId) => {
  logger.info("[meta.webhook] permissions revoked", { metaUserId });

  const accounts = await SocialAccount.find({
    platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
    status: { $in: [SOCIAL_ACCOUNT_STATUS.CONNECTED, SOCIAL_ACCOUNT_STATUS.EXPIRED] },
    $or: [{ accountId: metaUserId }, { pageId: metaUserId }],
  });

  for (const account of accounts) {
    await SocialAccount.findByIdAndUpdate(account._id, {
      $set: {
        status: SOCIAL_ACCOUNT_STATUS.DISCONNECTED,
        healthStatus: "critical",
        disconnectReason: "permissions_revoked",
      },
    });

    const notifData = { platform: account.platform, accountName: account.accountName };
    User.findById(account.userId).lean().then((user) => {
      const opts = user ? { userEmail: user.email, userName: user.name } : {};
      sendAppNotification(account.userId, "PERMISSIONS_REVOKED", notifData, opts);
    }).catch(() => {
      sendAppNotification(account.userId, "PERMISSIONS_REVOKED", notifData);
    });
  }

  if (accounts.length) {
    await cancelPendingSchedules(accounts.map((a) => a._id));
    const userIds = [...new Set(accounts.map((a) => a.userId.toString()))];
    for (const uid of userIds) {
      metaService.invalidateStateCache(uid);
    }
    logger.info("[meta.webhook] permissions revoked accounts", { count: accounts.length, metaUserId });
  }
};

/**
 * When a page's name or picture changes, update matching SocialAccount records
 * so the UI stays in sync without requiring the user to reconnect.
 */
const handlePageMetadataChange = async (pageId, field, value) => {
  const update = {};
  if (field === "name" && typeof value === "string") {
    update.accountName = value;
  } else if (field === "picture" && value) {
    // Meta sends picture as { url: "..." } or a direct string
    update.profilePictureUrl = typeof value === "string" ? value : value.url || "";
  }

  if (!Object.keys(update).length) return;

  const result = await SocialAccount.updateMany(
    {
      platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
      $or: [{ accountId: pageId }, { pageId }],
    },
    { $set: update }
  );

  if (result.modifiedCount) {
    logger.info("[meta.webhook] page metadata updated", { pageId, field, count: result.modifiedCount });
  }
};

// ── POST /webhooks/meta/data-deletion ─────────────────────────────────────────
// Meta requires this endpoint for App Review.
// Called when a user requests deletion of their data from Facebook settings.
// Meta sends a form-encoded body with a `signed_request` field.
router.post("/data-deletion", express.urlencoded({ extended: false }), (req, res) => {
  const { signed_request } = req.body;

  if (!signed_request || !env.meta.appSecret) {
    return res.status(400).json({ error: "Missing signed_request or app secret." });
  }

  let metaUserId;
  try {
    metaUserId = decodeSignedRequest(signed_request, env.meta.appSecret);
  } catch (err) {
    logger.warn("[meta.webhook] data-deletion signature invalid", { message: err.message });
    return res.status(400).json({ error: "Invalid signed_request." });
  }

  const confirmationCode = crypto.randomBytes(16).toString("hex");

  // Async deletion — do NOT await (Meta requires a fast response)
  SocialAccount.updateMany(
    {
      platform: { $in: [SOCIAL_PLATFORMS.FACEBOOK, SOCIAL_PLATFORMS.INSTAGRAM] },
      accountId: metaUserId,
    },
    {
      $set: {
        status: SOCIAL_ACCOUNT_STATUS.DISCONNECTED,
        accessToken: "",
        userAccessToken: "",
        disconnectReason: "data_deletion_request",
      },
    }
  ).catch((e) =>
    logger.error("[meta.webhook] data-deletion account wipe failed", { message: e.message })
  );

  // Audit trail — log data deletion request to WebhookEvent
  WebhookEvent.create({
    eventId: crypto.randomUUID(),
    object: "data_deletion",
    entryId: metaUserId,
    status: "processed",
    action: "data_deletion_request",
    rawPayload: { metaUserId, confirmationCode },
    receivedAt: new Date(),
    processedAt: new Date(),
  }).catch((e) =>
    logger.error("[meta.webhook] data-deletion audit log failed", { message: e.message })
  );

  logger.info("[meta.webhook] data deletion requested", { metaUserId, confirmationCode });

  return res.json({
    url: `${env.appUrl || ""}/api/v1/webhooks/meta/deletion-status?code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
});

/**
 * Decode Meta signed_request for data deletion callback.
 * Format: base64url(signature).base64url(JSON payload)
 */
function decodeSignedRequest(signedRequest, appSecret) {
  const parts = signedRequest.split(".");
  if (parts.length !== 2) throw new Error("Malformed signed_request.");
  const [encodedSig, encodedPayload] = parts;

  const sig = Buffer.from(encodedSig, "base64url");
  const expectedSig = crypto
    .createHmac("sha256", appSecret)
    .update(encodedPayload)
    .digest();

  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) {
    throw new Error("Signed request signature mismatch.");
  }

  const data = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  return data.user_id;
}

// ── GET /webhooks/meta/deletion-status ───────────────────────────────────────
// Optional: let Meta verify deletion completed (confirmation URL from data-deletion).
router.get("/deletion-status", (req, res) => {
  // We don't persist confirmation codes currently — just return a positive status.
  res.json({ status: "completed" });
});

module.exports = router;
