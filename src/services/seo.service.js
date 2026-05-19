const Business = require("../modules/business/business.model");
const User = require("../modules/user/user.model");
const SeoKeywordCache = require("../modules/seo/seoKeywordCache.model");
const { PLANS } = require("../constants/plans");
const googleTrendsService = require("./googleTrends.service");
const dataForSeoService = require("./dataForSeo.service");
const seoCacheService = require("./seoCache.service");
const logger = require("../core/logger");
const seoNotifier = require("./seoNotifier.service");

const PREMIUM_PLANS = [PLANS.PRO, PLANS.ADVANCED];

/**
 * Main SEO orchestrator.
 * Applies all Smart Rules in sequence to fetch/cache/reuse keyword and rank data.
 *
 * @param {string|ObjectId} businessId
 */
async function refreshBusinessSEO(businessId) {
  // Step 0 — Load business + user
  const business = await Business.findById(businessId);
  if (!business) {
    throw new Error(`Business not found: ${businessId}`);
  }

  const user = await User.findById(business.userId);
  if (!user) {
    throw new Error(`User not found for business: ${businessId}`);
  }

  const userPlan = user.plan; // read at runtime, never stored in business.seo
  const category = business.category;
  const city = business.addressDetails?.city;
  const state = business.addressDetails?.state;

  if (!category || !city) {
    throw new Error(
      `Business ${businessId} missing category or city — cannot fetch SEO data`
    );
  }

  const cacheKey = seoCacheService.buildCacheKey(category, city);
  const locationName = dataForSeoService.buildLocationName(city, state);

  logger.info(`[SEO ▶] Starting refresh for "${business.businessName}"`, {
    businessId: businessId.toString(),
    category,
    city,
    locationName,
    cacheKey,
  });

  // Initialize seo subdocument if missing (older businesses may not have it)
  if (!business.seo) {
    business.seo = {};
  }

  // Track whether this business was already counted for premiumUserCount (Bug 4 fix)
  // Must check BEFORE resetting status to "pending"
  const alreadyCounted =
    business.seo.keywordsFromCache === true ||
    (business.seo.status === "ready" && (business.seo.keywords?.length || 0) > 0);

  // Set initial state
  business.seo.cacheKey = cacheKey;
  business.seo.locationName = locationName;
  business.seo.status = "pending";
  business.seo.seoRefreshStartedAt = new Date();
  business.seo.lastError = "";
  await business.save();
  logger.info(`[SEO 1/3] Status set to "pending", DB saved`, { businessId: businessId.toString() });

  try {
    // Step 1 — Keywords: process each group (category + subcategories) independently
    const subcategories = (business.subcategories || []).filter((s) => s && s.trim());
    const groups = [
      { term: category, type: "category" },
      ...subcategories.map((s) => ({ term: s, type: "subcategory" })),
    ];
    const totalKeywords = 20;
    const perGroup = Math.floor(totalKeywords / groups.length);
    const remainder = totalKeywords % groups.length;

    logger.info(`[SEO 2/3] Processing ${groups.length} groups (1 category + ${subcategories.length} subcategories), ${totalKeywords} keywords total`, { businessId: businessId.toString() });

    const allKeywords = [];

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const count = perGroup + (i < remainder ? 1 : 0);
      const groupCacheKey = group.type === "category"
        ? seoCacheService.buildCacheKey(group.term, city)
        : seoCacheService.buildSubcategoryCacheKey(group.term, city);

      logger.info(`[SEO 2/3] Group ${i + 1}/${groups.length}: "${group.term}" (${group.type}), need ${count} keywords, cacheKey=${groupCacheKey}`, { businessId: businessId.toString() });

      const cachedEntry = await seoCacheService.checkCache(groupCacheKey);

      if (cachedEntry && cachedEntry.keywords?.length >= count) {
        // Cache hit — use cached keywords for this group
        logger.info(`[SEO 2/3] Cache HIT for [${groupCacheKey}] — using ${count} of ${cachedEntry.keywords.length} cached keywords`, { businessId: businessId.toString() });
        const cached = cachedEntry.keywords.slice(0, count).map((kw) => ({
          keyword: kw.keyword,
          monthlyVolume: kw.monthlyVolume,
          competition: kw.competition,
          trendValue: kw.trendValue,
          isRising: kw.isRising,
          source: kw.source || null,
          group: group.term,
          groupType: group.type,
          mapsRank: null,
          topBusiness: null,
          updatedAt: new Date(),
        }));
        allKeywords.push(...cached);

        // Update usage tracking
        if (PREMIUM_PLANS.includes(userPlan) && !alreadyCounted) {
          await SeoKeywordCache.updateOne(
            { cacheKey: groupCacheKey },
            { $set: { lastUsedAt: new Date() }, $inc: { premiumUserCount: 1 } }
          );
        } else {
          await SeoKeywordCache.updateOne(
            { cacheKey: groupCacheKey },
            { $set: { lastUsedAt: new Date() } }
          );
        }
      } else {
        // Cache miss — fetch fresh keywords for this group
        logger.info(`[SEO 2/3] Cache MISS for [${groupCacheKey}] — fetching fresh keywords`, { businessId: businessId.toString() });

        let trendKeywords = await googleTrendsService.getTrendsForTerm(group.term, city, count);
        if (!trendKeywords || trendKeywords.length < count) {
          const templates = googleTrendsService.generateSeedForTerm(group.term, city, state, count);
          if (!trendKeywords) {
            trendKeywords = templates;
          } else {
            const existing = new Set(trendKeywords.map((k) => k.keyword));
            for (const tpl of templates) {
              if (trendKeywords.length >= count) break;
              if (!existing.has(tpl.keyword)) trendKeywords.push(tpl);
            }
          }
        }
        trendKeywords = trendKeywords.slice(0, count);

        // Get search volumes
        const keywordStrings = trendKeywords.map((k) => k.keyword);
        logger.info(`[SEO 2/3] Fetching volumes for ${keywordStrings.length} keywords: ${keywordStrings.join(', ')}`, { businessId: businessId.toString() });
        const volumeData = await dataForSeoService.getKeywordVolumes(keywordStrings, locationName);

        // Merge trend + volume data
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

        // Save to group cache
        await seoCacheService.updateCache(groupCacheKey, {
          category,
          city,
          state,
          locationName,
          keywords: mergedKeywords,
          type: group.type,
          subcategory: group.type === "subcategory" ? group.term : "",
        });

        // Add group metadata and push to allKeywords
        for (const kw of mergedKeywords) {
          allKeywords.push({
            ...kw,
            group: group.term,
            groupType: group.type,
            mapsRank: null,
            topBusiness: null,
            updatedAt: new Date(),
          });
        }

        // If premium and not already counted, increment counter
        if (PREMIUM_PLANS.includes(userPlan) && !alreadyCounted) {
          await SeoKeywordCache.updateOne(
            { cacheKey: groupCacheKey },
            { $inc: { premiumUserCount: 1 } }
          );
        }
      }
    }

    // Save all grouped keywords to business
    business.seo.keywords = allKeywords;
    business.seo.keywordsFromCache = false;
    business.seo.lastKeywordRefresh = new Date();
    business.seo.status = "keywords_ready";
    await business.save();
    logger.info(`[SEO 2/3] keywords_ready — ${allKeywords.length} keywords saved to DB`, { businessId: businessId.toString() });

    // Push intermediate status so frontend can display keywords immediately
    seoNotifier.notifySeoStatus(businessId, business.userId, business.seo);
    logger.info(`[SEO 2/3] keywords_ready emitted to frontend via socket`, { businessId: businessId.toString() });

    // Step 2 — Rank fetch for ALL users (Rule 4 updated)
    // Skip if rank data is fresh (< 1 hour old) to avoid unnecessary API cost
    const RANK_FRESHNESS_MS = 60 * 60 * 1000; // 1 hour
    const lastRank = business.seo.lastRankRefresh;
    const rankIsFresh =
      lastRank &&
      Date.now() - new Date(lastRank).getTime() < RANK_FRESHNESS_MS;

    if (rankIsFresh) {
      logger.info(`[SEO 3/3] Rank data is FRESH (fetched < 1h ago), skipping Maps API call`, {
        businessId: businessId.toString(),
        lastRankRefresh: lastRank,
      });
      // Still mark as ready so frontend shows the existing rank data
      business.seo.rankDataAvailable = true;
      business.seo.status = "ready";
      business.seo.lastError = "";
      await business.save();
    } else {
      const keywordsForRank = business.seo.keywords.map((k) => k.keyword);
      logger.info(`[SEO 3/3] Fetching Google Maps rankings for ${keywordsForRank.length} keywords (this takes ~2 min)...`, { businessId: businessId.toString(), keywords: keywordsForRank });
      const rankings = await dataForSeoService.getLocalRankings(
        keywordsForRank,
        locationName,
        business.businessName
      );

      // Merge rank positions into business.seo.keywords
      for (const rank of rankings) {
        const kwEntry = business.seo.keywords.find(
          (k) => k.keyword.toLowerCase() === rank.keyword.toLowerCase()
        );
        if (kwEntry) {
          kwEntry.mapsRank = rank.mapsRank;
          kwEntry.topBusiness = rank.topBusiness;
          kwEntry.updatedAt = new Date();
        }
      }

      logger.info(`[SEO 3/3] Google Maps rankings received: ${rankings.length} results`, {
        businessId: businessId.toString(),
        ranked: rankings.filter(r => r.mapsRank !== null).map(r => `${r.keyword}:#${r.mapsRank}`),
        notListed: rankings.filter(r => r.mapsRank === null).map(r => r.keyword),
      });
      business.seo.rankDataAvailable = true;
      business.seo.lastRankRefresh = new Date();
      business.seo.status = "ready";
      business.seo.lastError = "";
      await business.save();
    }

    // Push final data to frontend via Socket.IO + create notification
    logger.info(`[SEO ✓] Complete! Emitting seo:ready to frontend`, { businessId: businessId.toString() });
    seoNotifier.notifySeoReady(businessId, business.userId, business.seo).catch(() => {});

    logger.info("SEO refresh complete", {
      businessId,
      cacheKey,
      plan: userPlan,
      keywordCount: business.seo.keywords.length,
      rankedCount: business.seo.keywords.filter((k) => k.mapsRank !== null).length,
    });

    return business.seo;
  } catch (err) {
    // Mark business as error state
    business.seo.status = "error";
    business.seo.lastError = err.message;
    await business.save();

    seoNotifier.notifySeoError(businessId, business.userId, err.message).catch(() => {});

    logger.error("[SEO ✗] Refresh FAILED", {
      businessId,
      cacheKey,
      error: err.message,
    });

    throw err;
  }
}

/**
 * Refresh only rank data for a business (used by weekly cron for premium users).
 */
async function refreshRankOnly(businessId) {
  const business = await Business.findById(businessId);
  if (!business) {
    throw new Error(`Business not found: ${businessId}`);
  }

  if (!business.seo.keywords.length) {
    throw new Error(`Business ${businessId} has no keywords — run full refresh first`);
  }

  const locationName = business.seo.locationName;
  const keywordsForRank = business.seo.keywords.map((k) => k.keyword);

  try {
    const rankings = await dataForSeoService.getLocalRankings(
      keywordsForRank,
      locationName,
      business.businessName
    );

    for (const rank of rankings) {
      const kwEntry = business.seo.keywords.find(
        (k) => k.keyword.toLowerCase() === rank.keyword.toLowerCase()
      );
      if (kwEntry) {
        kwEntry.mapsRank = rank.mapsRank;
        kwEntry.topBusiness = rank.topBusiness;
        kwEntry.updatedAt = new Date();
      }
    }

    business.seo.rankDataAvailable = true;
    business.seo.lastRankRefresh = new Date();
    business.seo.status = "ready";
    business.seo.lastError = "";
    await business.save();

    seoNotifier.notifySeoReady(businessId, business.userId, business.seo).catch(() => {});

    logger.info("Rank-only refresh complete", {
      businessId,
      rankedCount: business.seo.keywords.filter((k) => k.mapsRank !== null).length,
    });

    return business.seo;
  } catch (err) {
    business.seo.status = "error";
    business.seo.lastError = err.message;
    await business.save();

    seoNotifier.notifySeoError(businessId, business.userId, err.message).catch(() => {});

    logger.error("Rank-only refresh failed", {
      businessId,
      error: err.message,
    });

    throw err;
  }
}

module.exports = {
  refreshBusinessSEO,
  refreshRankOnly,
};
