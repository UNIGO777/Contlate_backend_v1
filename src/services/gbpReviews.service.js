const env = require("../config/env");
const logger = require("../core/logger");
const ApiError = require("../core/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const GbpAccount = require("../modules/seo/gbpAccount.model");
const GbpReviews = require("../modules/seo/gbpReviews.model");
const gbpOAuthService = require("./gbpOAuth.service");

// Reviews still live on the legacy My Business v4 API; there is no v1
// equivalent. Access is allowlisted per Google Cloud project.
const MB_V4_BASE = "https://mybusiness.googleapis.com/v4";

const STAR_WORDS = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

const starToNumber = (rating) => STAR_WORDS[String(rating || "").toUpperCase()] ?? 0;

/** Stored with prefixes already: "accounts/123" + "locations/456". */
const buildReviewsPath = (accountId, locationId) => {
  const acct = String(accountId || "").replace(/^\/+|\/+$/g, "");
  const loc = String(locationId || "").replace(/^\/+|\/+$/g, "");
  return `${acct}/${loc}/reviews`;
};

const mapReview = (r) => ({
  reviewId: r?.reviewId ?? r?.name ?? "",
  authorName: r?.reviewer?.isAnonymous ? "Anonymous" : r?.reviewer?.displayName ?? "",
  authorPhotoUrl: r?.reviewer?.profilePhotoUrl ?? "",
  starRating: starToNumber(r?.starRating),
  // Star-only reviews carry no comment; keep them, they still count.
  comment: r?.comment ?? "",
  createTime: r?.createTime ? new Date(r.createTime) : null,
  updateTime: r?.updateTime ? new Date(r.updateTime) : null,
  replyComment: r?.reviewReply?.comment ?? null,
  replyUpdateTime: r?.reviewReply?.updateTime ? new Date(r.reviewReply.updateTime) : null,
});

async function fetchReviewsPage({ accessToken, path, pageToken }) {
  const url = new URL(`${MB_V4_BASE}/${path}`);
  url.searchParams.set("pageSize", "50");
  url.searchParams.set("orderBy", "updateTime desc");
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`GBP reviews ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Cached read. Google is only called when the cache has expired; `force`
 * still respects a floor so repeated pulls can't burn the v4 quota.
 */
async function getReviews(businessId, { force = false } = {}) {
  const cached = await GbpReviews.findOne({ businessId });
  const now = Date.now();

  const minGapMs = env.gbp.reviewsMinRefreshMinutes * 60 * 1000;
  const tooSoon = cached && now - new Date(cached.fetchedAt).getTime() < minGapMs;
  const fresh = cached && new Date(cached.expiresAt).getTime() > now;

  if (cached && (fresh || (force && tooSoon))) {
    return { ...cached.toObject(), cacheHit: true, throttled: force && tooSoon };
  }

  const gbpAccount = await GbpAccount.findOne({ businessId });
  if (!gbpAccount || gbpAccount.status !== "connected" || !gbpAccount.gbpLocationId) {
    throw new ApiError(400, "Google Business Profile is not connected.", {
      code: ERROR_CODES.GBP_NOT_CONNECTED,
    });
  }

  const path = buildReviewsPath(gbpAccount.gbpAccountId, gbpAccount.gbpLocationId);

  try {
    const accessToken = await gbpOAuthService.getValidAccessToken(gbpAccount);

    // One page is enough for the UI; a second is pulled only if the first is
    // full, so a location with thousands of reviews doesn't spin the quota.
    const first = await fetchReviewsPage({ accessToken, path });
    let collected = Array.isArray(first?.reviews) ? [...first.reviews] : [];
    if (first?.nextPageToken && collected.length >= 50) {
      const second = await fetchReviewsPage({
        accessToken,
        path,
        pageToken: first.nextPageToken,
      });
      if (Array.isArray(second?.reviews)) collected = collected.concat(second.reviews);
    }

    const reviews = collected.map(mapReview);
    const unansweredCount = reviews.filter((r) => !r.replyComment).length;

    const doc = await GbpReviews.findOneAndUpdate(
      { businessId },
      {
        businessId,
        gbpLocationId: gbpAccount.gbpLocationId,
        reviews,
        // Google's own totals cover the whole location, not just this page.
        averageRating: Number(first?.averageRating ?? 0),
        totalReviewCount: Number(first?.totalReviewCount ?? reviews.length),
        unansweredCount,
        fetchedAt: new Date(),
        expiresAt: new Date(now + env.gbp.reviewsTtlHours * 60 * 60 * 1000),
        lastError: null,
        lastErrorAt: null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    logger.info("[gbp] reviews refreshed", {
      businessId: String(businessId),
      count: reviews.length,
      unanswered: unansweredCount,
    });

    return { ...doc.toObject(), cacheHit: false, throttled: false };
  } catch (err) {
    logger.error("[gbp] reviews refresh failed", {
      businessId: String(businessId),
      status: err.status,
      message: err.message,
    });

    if (cached) {
      await GbpReviews.updateOne(
        { businessId },
        { lastError: String(err.message).slice(0, 300), lastErrorAt: new Date() }
      );
      return { ...cached.toObject(), cacheHit: true, stale: true, lastError: err.message };
    }

    // 403 here usually means the project is not allowlisted for v4 rather
    // than a user-permission problem — say so instead of a generic failure.
    if (err.status === 403) {
      throw new ApiError(403, "Reviews access is not enabled for this app yet.", {
        code: ERROR_CODES.GBP_NOT_CONNECTED,
        details: { reason: "my_business_v4_not_enabled" },
      });
    }
    if (err.status === 429) {
      throw new ApiError(429, "Google is rate limiting us. Please try again later.", {
        code: ERROR_CODES.VALIDATION_FAILED,
      });
    }
    throw new ApiError(502, "Could not load Google reviews.", {
      code: ERROR_CODES.GBP_NOT_CONNECTED,
    });
  }
}

module.exports = { getReviews, buildReviewsPath, starToNumber, mapReview };
