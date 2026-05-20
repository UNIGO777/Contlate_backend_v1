const Business = require("../modules/business/business.model");
const User = require("../modules/user/user.model");
const SeoKeywordCache = require("../modules/seo/seoKeywordCache.model");
const AiSeo = require("../modules/ai-seo/aiSeo.model");
const aiSeoService = require("../modules/ai-seo/aiSeo.service");
const { PLANS } = require("../constants/plans");
const googleTrendsService = require("../services/googleTrends.service");
const dataForSeoService = require("../services/dataForSeo.service");
const seoCacheService = require("../services/seoCache.service");
const seoService = require("../services/seo.service");
const logger = require("../core/logger");

const PREMIUM_PLANS = [PLANS.PRO, PLANS.ADVANCED];
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 3000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Check intervals
const MONTHLY_CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly check
const WEEKLY_CHECK_INTERVAL_MS = 60 * 60 * 1000;  // hourly check

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process items in batches of BATCH_SIZE with BATCH_DELAY_MS between businesses.
 */
async function processInBatches(items, processFn, label) {
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    for (const item of batch) {
      try {
        await processFn(item);
        processed++;
      } catch (err) {
        failed++;
        logger.error(`[seoRefresh] ${label} failed for item`, {
          itemId: item._id?.toString(),
          error: err.message,
        });
      }

      // Delay between businesses to respect DataForSEO rate limits
      if (i + batch.indexOf(item) < items.length - 1) {
        await sleep(BATCH_DELAY_MS);
      }
    }
  }

  return { processed, failed };
}

// ─── Monthly Keyword Refresh ────────────────────────────────────────────────
// Schedule: 1st of every month at 2:00 AM IST
// Only refreshes cache entries where premiumUserCount > 0

async function runMonthlyKeywordRefresh() {
  const now = new Date();

  // Find expired cache entries with active premium users
  const expiredEntries = await SeoKeywordCache.find({
    expiresAt: { $lte: now },
    premiumUserCount: { $gt: 0 },
  });

  if (expiredEntries.length === 0) {
    logger.info("[seoRefresh] monthly keyword — no expired entries with premium users");
    return { refreshed: 0, skipped: 0, failed: 0 };
  }

  logger.info(`[seoRefresh] monthly keyword — ${expiredEntries.length} entries to refresh`);

  const results = await processInBatches(
    expiredEntries,
    async (entry) => {
      // Fetch fresh keywords
      const trendKeywords = await googleTrendsService.getKeywords(
        entry.category,
        entry.city,
        [],
        [],
        entry.state
      );

      const keywordStrings = trendKeywords.map((k) => k.keyword);
      const locationName = entry.locationName || dataForSeoService.buildLocationName(entry.city, entry.state);

      const volumeData = await dataForSeoService.getKeywordVolumes(
        keywordStrings,
        locationName
      );

      // Merge trend data with volume data
      const mergedKeywords = trendKeywords.map((trend) => {
        const volume = volumeData.find(
          (v) => v.keyword.toLowerCase() === trend.keyword.toLowerCase()
        );
        return {
          keyword: trend.keyword,
          monthlyVolume: volume?.monthlyVolume || 0,
          competition: volume?.competition || null,
          trendValue: trend.trendValue,
          isRising: trend.isRising,
          source: trend.source || null,
        };
      });

      // Update the cache entry
      await seoCacheService.updateCache(entry.cacheKey, {
        category: entry.category,
        city: entry.city,
        state: entry.state,
        locationName,
        keywords: mergedKeywords,
      });

      // Propagate updated keywords to all businesses using this cacheKey
      const businesses = await Business.find({ "seo.cacheKey": entry.cacheKey });
      for (const biz of businesses) {
        biz.seo.keywords = mergedKeywords.map((kw) => ({
          ...kw,
          // Preserve existing rank data
          mapsRank: biz.seo.keywords.find(
            (k) => k.keyword.toLowerCase() === kw.keyword.toLowerCase()
          )?.mapsRank || null,
          topBusiness: biz.seo.keywords.find(
            (k) => k.keyword.toLowerCase() === kw.keyword.toLowerCase()
          )?.topBusiness || null,
          updatedAt: new Date(),
        }));
        biz.seo.lastKeywordRefresh = new Date();
        biz.seo.keywordsFromCache = true;
        await biz.save();
      }

      logger.info("[seoRefresh] monthly keyword — refreshed cache entry", {
        cacheKey: entry.cacheKey,
        businessCount: businesses.length,
      });
    },
    "monthly keyword"
  );

  logger.info("[seoRefresh] monthly keyword refresh complete", results);
  return results;
}

// ─── Weekly Rank Refresh ────────────────────────────────────────────────────
// Schedule: Every Monday at 3:00 AM IST
// Only refreshes rank for premium users whose rank data is > 7 days old

async function runWeeklyRankRefresh() {
  const staleDate = new Date(Date.now() - SEVEN_DAYS_MS);

  // Find businesses with stale or missing rank data (includes null lastRankRefresh)
  const staleBizIds = await Business.find({
    $or: [
      { "seo.lastRankRefresh": { $lte: staleDate } },
      { "seo.lastRankRefresh": null },
    ],
    "seo.status": { $in: ["ready", "keywords_ready", "error"] },
    "seo.keywords.0": { $exists: true }, // has at least one keyword
  }).select("_id userId");

  if (staleBizIds.length === 0) {
    logger.info("[seoRefresh] weekly rank — no stale businesses found");
    return { refreshed: 0, skipped: 0, failed: 0 };
  }

  // Filter to only premium users (lookup user.plan, NOT from business.seo)
  const premiumBusinesses = [];
  for (const biz of staleBizIds) {
    const user = await User.findById(biz.userId).select("plan");
    if (user && PREMIUM_PLANS.includes(user.plan)) {
      premiumBusinesses.push(biz);
    }
  }

  if (premiumBusinesses.length === 0) {
    logger.info("[seoRefresh] weekly rank — no premium businesses with stale data");
    return { refreshed: 0, skipped: staleBizIds.length, failed: 0 };
  }

  logger.info(`[seoRefresh] weekly rank — ${premiumBusinesses.length} premium businesses to refresh`);

  const results = await processInBatches(
    premiumBusinesses,
    async (biz) => {
      await seoService.refreshRankOnly(biz._id);
      logger.info("[seoRefresh] weekly rank — refreshed business", {
        businessId: biz._id,
      });
    },
    "weekly rank"
  );

  logger.info("[seoRefresh] weekly rank refresh complete", results);
  return results;
}

// ─── AI SEO Monthly Rank Refresh ───────────────────────────────────────────
// Only for Advanced plan users with active (non-completed) keyword cycles.
// Runs on the 1st of every month alongside the existing keyword refresh.

async function runAiSeoMonthlyRefresh() {
  // Find all AI SEO records that are ready, not at month 3, and stale (>25 days)
  const staleCutoff = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000);
  const records = await AiSeo.find({
    status: "ready",
    currentMonth: { $lt: 3 },
    $or: [
      { lastRefreshedAt: { $lte: staleCutoff } },
      { lastRefreshedAt: null },
    ],
  }).select("businessId userId");

  if (records.length === 0) {
    logger.info("[seoRefresh] ai-seo monthly — no records to refresh");
    return { refreshed: 0, failed: 0 };
  }

  // Filter to Advanced plan users only
  const advancedRecords = [];
  for (const rec of records) {
    const user = await User.findById(rec.userId).select("plan");
    if (user && user.plan === PLANS.ADVANCED) {
      advancedRecords.push(rec);
    }
  }

  if (advancedRecords.length === 0) {
    logger.info("[seoRefresh] ai-seo monthly — no Advanced users to refresh");
    return { refreshed: 0, failed: 0 };
  }

  logger.info(`[seoRefresh] ai-seo monthly — ${advancedRecords.length} Advanced users to refresh`);

  const results = await processInBatches(
    advancedRecords,
    async (rec) => {
      await aiSeoService.refreshKeywords(rec.businessId);
      logger.info("[seoRefresh] ai-seo monthly — refreshed", {
        businessId: rec.businessId,
      });
    },
    "ai-seo monthly"
  );

  logger.info("[seoRefresh] ai-seo monthly refresh complete", results);
  return results;
}

// ─── Scheduler ──────────────────────────────────────────────────────────────
// Runs hourly, checks if it's time for monthly or weekly refresh.
// Uses IST (UTC+5:30) for schedule matching.

let monthlyTimer = null;
let weeklyTimer = null;
let lastMonthlyRun = null;
let lastWeeklyRun = null;

function getISTDate() {
  const now = new Date();
  // IST is UTC+5:30
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(now.getTime() + istOffset);
}

async function monthlyTick() {
  try {
    const ist = getISTDate();
    const dayOfMonth = ist.getUTCDate();
    const hour = ist.getUTCHours();

    // Run on the 1st of the month, after 2:00 AM IST
    if (dayOfMonth !== 1 || hour < 2) return;

    // Only run once per day
    const today = ist.toISOString().slice(0, 10);
    if (lastMonthlyRun === today) return;

    lastMonthlyRun = today;
    await runMonthlyKeywordRefresh();
    await runAiSeoMonthlyRefresh();
  } catch (err) {
    logger.error("[seoRefresh] monthly tick error", {
      message: err.message,
      stack: err.stack,
    });
  }
}

async function weeklyTick() {
  try {
    const ist = getISTDate();
    const dayOfWeek = ist.getUTCDay(); // 0=Sunday, 1=Monday
    const hour = ist.getUTCHours();

    // Run on Monday, after 3:00 AM IST
    if (dayOfWeek !== 1 || hour < 3) return;

    // Only run once per day
    const today = ist.toISOString().slice(0, 10);
    if (lastWeeklyRun === today) return;

    lastWeeklyRun = today;
    await runWeeklyRankRefresh();
  } catch (err) {
    logger.error("[seoRefresh] weekly tick error", {
      message: err.message,
      stack: err.stack,
    });
  }
}

const start = () => {
  if (monthlyTimer) return;

  // Run both checks hourly
  monthlyTimer = setInterval(monthlyTick, MONTHLY_CHECK_INTERVAL_MS);
  weeklyTimer = setInterval(weeklyTick, WEEKLY_CHECK_INTERVAL_MS);

  if (typeof monthlyTimer.unref === "function") monthlyTimer.unref();
  if (typeof weeklyTimer.unref === "function") weeklyTimer.unref();

  logger.info("[seoRefresh] SEO refresh job started (hourly check for monthly/weekly schedules)");
};

const stop = () => {
  if (monthlyTimer) {
    clearInterval(monthlyTimer);
    monthlyTimer = null;
  }
  if (weeklyTimer) {
    clearInterval(weeklyTimer);
    weeklyTimer = null;
  }
};

module.exports = {
  start,
  stop,
  runMonthlyKeywordRefresh,
  runWeeklyRankRefresh,
  runAiSeoMonthlyRefresh,
};
