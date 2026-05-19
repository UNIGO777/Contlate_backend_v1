const { getIO } = require("../core/socket");
const logger = require("../core/logger");

// Lazy-require to avoid circular dependency at boot
let Notification;
function getNotificationModel() {
  if (!Notification) {
    Notification = require("../modules/notification/notification.model");
  }
  return Notification;
}

/**
 * Group flat keywords array by group/groupType for frontend display.
 */
function buildGroupedKeywords(keywords) {
  const groups = {};
  for (const kw of keywords) {
    const key = kw.group || "other";
    if (!groups[key]) {
      groups[key] = { group: key, groupType: kw.groupType || "category", keywords: [] };
    }
    groups[key].keywords.push(kw);
  }
  return Object.values(groups);
}

/**
 * Emit intermediate SEO status update (e.g. keywords_ready).
 * No notification document — the process is still in progress.
 */
function notifySeoStatus(businessId, userId, seoData) {
  const io = getIO();
  if (!io) return;

  const payload = {
    businessId: businessId.toString(),
    status: seoData.status,
    keywords: seoData.keywords || [],
    groupedKeywords: buildGroupedKeywords(seoData.keywords || []),
    keywordCount: seoData.keywords?.length || 0,
    rankDataAvailable: seoData.rankDataAvailable || false,
    lastKeywordRefresh: seoData.lastKeywordRefresh || null,
    seoRefreshStartedAt: seoData.seoRefreshStartedAt || null,
  };

  io.to(`business:${businessId}`).emit("seo:status", payload);
  logger.info("[seoNotifier] emitted seo:status", {
    businessId: businessId.toString(),
    status: seoData.status,
  });
}

/**
 * Emit final SEO ready event + create persistent notification.
 */
async function notifySeoReady(businessId, userId, seoData) {
  const io = getIO();
  const NotificationModel = getNotificationModel();

  const payload = {
    businessId: businessId.toString(),
    status: "ready",
    keywords: seoData.keywords || [],
    groupedKeywords: buildGroupedKeywords(seoData.keywords || []),
    keywordCount: seoData.keywords?.length || 0,
    rankDataAvailable: true,
    lastRankRefresh: seoData.lastRankRefresh || null,
    lastKeywordRefresh: seoData.lastKeywordRefresh || null,
  };

  if (io) {
    io.to(`business:${businessId}`).emit("seo:ready", payload);
  }

  // Create persistent notification
  try {
    const notification = await NotificationModel.create({
      userId,
      type: "seo_ready",
      title: "SEO Rankings Ready",
      message: `Your keyword rankings are now available. ${payload.keywordCount} keywords analyzed.`,
      meta: { businessId: businessId.toString(), keywordCount: payload.keywordCount },
    });

    if (io) {
      io.to(`user:${userId}`).emit("notification:new", notification.toObject());
    }
  } catch (err) {
    logger.warn("[seoNotifier] failed to create notification", { error: err.message });
  }

  logger.info("[seoNotifier] emitted seo:ready", {
    businessId: businessId.toString(),
  });
}

/**
 * Emit SEO error event + create persistent notification.
 */
async function notifySeoError(businessId, userId, errorMsg) {
  const io = getIO();
  const NotificationModel = getNotificationModel();

  const payload = {
    businessId: businessId.toString(),
    status: "error",
    lastError: errorMsg,
  };

  if (io) {
    io.to(`business:${businessId}`).emit("seo:error", payload);
  }

  try {
    const notification = await NotificationModel.create({
      userId,
      type: "seo_error",
      title: "SEO Research Failed",
      message: "We couldn't complete your SEO research. Please try again later.",
      meta: { businessId: businessId.toString(), error: errorMsg },
    });

    if (io) {
      io.to(`user:${userId}`).emit("notification:new", notification.toObject());
    }
  } catch (err) {
    logger.warn("[seoNotifier] failed to create error notification", { error: err.message });
  }

  logger.info("[seoNotifier] emitted seo:error", {
    businessId: businessId.toString(),
  });
}

module.exports = { notifySeoStatus, notifySeoReady, notifySeoError };
