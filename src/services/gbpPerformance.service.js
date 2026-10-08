const env = require("../config/env");
const logger = require("../core/logger");
const ApiError = require("../core/ApiError");
const { ERROR_CODES } = require("../constants/errorCodes");
const GbpAccount = require("../modules/seo/gbpAccount.model");
const GbpInsights = require("../modules/seo/gbpInsights.model");
const gbpOAuthService = require("./gbpOAuth.service");

const PERF_BASE = "https://businessprofileperformance.googleapis.com/v1";

/**
 * Daily metrics we pull. Impressions are split four ways by Google, so "views"
 * is the sum of all four; maps/search subtotals are kept for the detail screen.
 */
const IMPRESSION_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
];
const ACTION_METRICS = ["CALL_CLICKS", "BUSINESS_DIRECTION_REQUESTS", "WEBSITE_CLICKS"];
const ALL_METRICS = [...IMPRESSION_METRICS, ...ACTION_METRICS];

const MAPS_METRICS = new Set([
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
]);

/** Stored as "accounts/123/locations/456"; the Performance API wants "456". */
const normalizeLocationId = (raw) => {
  if (!raw) return "";
  const parts = String(raw).split("/");
  const idx = parts.lastIndexOf("locations");
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : parts[parts.length - 1];
};

const toDateParams = (prefix, date) =>
  [
    `${prefix}.year=${date.getUTCFullYear()}`,
    `${prefix}.month=${date.getUTCMonth() + 1}`,
    `${prefix}.day=${date.getUTCDate()}`,
  ].join("&");

const emptyTotals = () => ({
  views: 0,
  viewsMaps: 0,
  viewsSearch: 0,
  calls: 0,
  directions: 0,
  websiteClicks: 0,
});

/**
 * One call returns every requested metric as a parallel time series.
 * Google omits zero-valued days, so callers must not assume a dense array.
 */
async function fetchMultiDailyMetrics({ accessToken, locationId, start, end }) {
  const params = [
    ...ALL_METRICS.map((m) => `dailyMetrics=${m}`),
    toDateParams("dailyRange.start_date", start),
    toDateParams("dailyRange.end_date", end),
  ].join("&");

  const url = `${PERF_BASE}/locations/${locationId}:fetchMultiDailyMetricsTimeSeries?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`GBP performance ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Collapse Google's per-metric series into totals plus a dense daily array. */
function foldSeries(payload, start, end) {
  const totals = emptyTotals();
  const byDay = new Map();

  const dayKey = (d) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  const bucket = (key) => {
    if (!byDay.has(key)) {
      byDay.set(key, { views: 0, calls: 0, directions: 0, websiteClicks: 0 });
    }
    return byDay.get(key);
  };

  for (const series of payload?.multiDailyMetricTimeSeries ?? []) {
    for (const entry of series?.dailyMetricTimeSeries ?? []) {
      const metric = entry?.dailyMetric;
      for (const point of entry?.timeSeries?.datedValues ?? []) {
        // Google omits `value` entirely on zero days.
        const value = Number(point?.value ?? 0);
        if (!point?.date || !value) continue;
        const slot = bucket(dayKey(point.date));

        if (IMPRESSION_METRICS.includes(metric)) {
          totals.views += value;
          slot.views += value;
          if (MAPS_METRICS.has(metric)) totals.viewsMaps += value;
          else totals.viewsSearch += value;
        } else if (metric === "CALL_CLICKS") {
          totals.calls += value;
          slot.calls += value;
        } else if (metric === "BUSINESS_DIRECTION_REQUESTS") {
          totals.directions += value;
          slot.directions += value;
        } else if (metric === "WEBSITE_CLICKS") {
          totals.websiteClicks += value;
          slot.websiteClicks += value;
        }
      }
    }
  }

  // Fill the gaps Google left out so the chart has a continuous x-axis.
  const daily = [];
  for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const slot = byDay.get(key) ?? { views: 0, calls: 0, directions: 0, websiteClicks: 0 };
    daily.push({ date: new Date(d), ...slot });
  }

  return { totals, daily };
}

const pctChange = (current, previous) => {
  if (!previous) return null; // no baseline — a delta would be meaningless
  return Math.round(((current - previous) / previous) * 100);
};

/**
 * Cached read. Hits Google only when the cache is missing or past expiry.
 * `force` still respects a hard floor so a pull-to-refresh loop can't burn
 * the project's daily quota.
 */
async function getInsights(businessId, { force = false } = {}) {
  const cached = await GbpInsights.findOne({ businessId });
  const now = Date.now();

  const minGapMs = env.gbp.insightsMinRefreshMinutes * 60 * 1000;
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

  const locationId = normalizeLocationId(gbpAccount.gbpLocationId);
  const windowDays = env.gbp.insightsWindowDays;

  // Google's data lags ~2 days, so end the window there rather than today.
  const end = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  end.setUTCDate(end.getUTCDate() - 2);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - windowDays);
  const prevStart = new Date(start);
  prevStart.setUTCDate(prevStart.getUTCDate() - windowDays);

  try {
    const accessToken = await gbpOAuthService.getValidAccessToken(gbpAccount);

    const [currentPayload, previousPayload] = await Promise.all([
      fetchMultiDailyMetrics({ accessToken, locationId, start, end }),
      fetchMultiDailyMetrics({ accessToken, locationId, start: prevStart, end: start }),
    ]);

    const current = foldSeries(currentPayload, new Date(start), new Date(end));
    const previous = foldSeries(previousPayload, new Date(prevStart), new Date(start));

    const doc = await GbpInsights.findOneAndUpdate(
      { businessId },
      {
        businessId,
        gbpLocationId: gbpAccount.gbpLocationId,
        rangeStart: start,
        rangeEnd: end,
        totals: current.totals,
        previousTotals: previous.totals,
        deltaPct: {
          views: pctChange(current.totals.views, previous.totals.views),
          calls: pctChange(current.totals.calls, previous.totals.calls),
          directions: pctChange(current.totals.directions, previous.totals.directions),
        },
        daily: current.daily,
        fetchedAt: new Date(),
        expiresAt: new Date(now + env.gbp.insightsTtlHours * 60 * 60 * 1000),
        lastError: null,
        lastErrorAt: null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    logger.info("[gbp] insights refreshed", {
      businessId: String(businessId),
      views: current.totals.views,
      calls: current.totals.calls,
      directions: current.totals.directions,
    });

    return { ...doc.toObject(), cacheHit: false, throttled: false };
  } catch (err) {
    logger.error("[gbp] insights refresh failed", {
      businessId: String(businessId),
      status: err.status,
      message: err.message,
    });

    // Stale data beats an error screen — serve what we have and say it's stale.
    if (cached) {
      await GbpInsights.updateOne(
        { businessId },
        { lastError: String(err.message).slice(0, 300), lastErrorAt: new Date() }
      );
      return { ...cached.toObject(), cacheHit: true, stale: true, lastError: err.message };
    }

    if (err.status === 429) {
      throw new ApiError(429, "Google is rate limiting us. Please try again later.", {
        code: ERROR_CODES.GBP_RATE_LIMITED ?? ERROR_CODES.VALIDATION_FAILED,
      });
    }
    throw new ApiError(502, "Could not load Google performance data.", {
      code: ERROR_CODES.GBP_NOT_CONNECTED,
    });
  }
}

module.exports = { getInsights, normalizeLocationId, foldSeries };
