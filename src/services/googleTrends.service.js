const googleTrends = require("google-trends-api");
const logger = require("../core/logger");

/**
 * Generate seed keywords from business profile data.
 * No API call needed — pure template logic.
 */
function generateSeedKeywords(category, city, services = [], subcategories = [], state = "") {
  const cat = category.toLowerCase().trim();
  const cty = city.toLowerCase().trim();
  const st = state ? state.toLowerCase().trim() : "";

  const keywords = new Set();

  // Core templates
  keywords.add(`${cat} in ${cty}`);
  keywords.add(`${cat} near me`);
  keywords.add(`best ${cat} ${cty}`);
  keywords.add(`${cat} ${cty}`);
  if (st) {
    keywords.add(`${cat} ${cty} ${st}`);
  }
  keywords.add(`${cat} open now`);
  keywords.add(`${cat} appointment ${cty}`);
  keywords.add(`affordable ${cat} ${cty}`);
  keywords.add(`top rated ${cat} ${cty}`);

  // Service-based keywords
  for (const service of services) {
    const svc = service.toLowerCase().trim();
    if (svc) {
      keywords.add(`${svc} ${cty}`);
      keywords.add(`${svc} near me`);
    }
  }

  // Subcategory-based keywords
  for (const subcat of subcategories) {
    const sc = subcat.toLowerCase().trim();
    if (sc) {
      keywords.add(`${sc} ${cty}`);
    }
  }

  // Take top 20
  const result = [...keywords].slice(0, 20).map((keyword) => ({
    keyword,
    trendValue: null,
    isRising: null,
    source: "template",
  }));

  return result;
}

/**
 * Try to get related + rising keywords from Google Trends.
 * Falls back to seed template if anything goes wrong.
 */
async function getKeywords(category, city, services = [], subcategories = [], state = "") {
  const seedKeyword = `${category} ${city}`;

  try {
    // Fetch related queries from Google Trends (India region)
    const relatedRaw = await googleTrends.relatedQueries({
      keyword: seedKeyword,
      geo: "IN",
    });

    const relatedData = JSON.parse(relatedRaw);
    const defaultNode = relatedData?.default;

    if (!defaultNode || !defaultNode.rankedList || defaultNode.rankedList.length === 0) {
      logger.warn("Google Trends returned empty data, using seed template", {
        seedKeyword,
      });
      return generateSeedKeywords(category, city, services, subcategories, state);
    }

    const keywords = new Map();

    // rankedList[0] = top queries, rankedList[1] = rising queries
    const topQueries = defaultNode.rankedList[0]?.rankedKeyword || [];
    const risingQueries = defaultNode.rankedList[1]?.rankedKeyword || [];

    for (const item of topQueries) {
      const kw = item.query?.toLowerCase().trim();
      if (kw && !keywords.has(kw)) {
        keywords.set(kw, {
          keyword: kw,
          trendValue: item.value || 0,
          isRising: false,
          source: "google_trends",
        });
      }
    }

    for (const item of risingQueries) {
      const kw = item.query?.toLowerCase().trim();
      if (kw) {
        // Rising queries override top queries — they're more valuable
        keywords.set(kw, {
          keyword: kw,
          trendValue: item.value || 0,
          isRising: true,
          source: "google_trends",
        });
      }
    }

    // If Trends gave us fewer than 10 keywords, pad with seed templates
    if (keywords.size < 10) {
      const seeds = generateSeedKeywords(category, city, services, subcategories, state);
      for (const seed of seeds) {
        if (!keywords.has(seed.keyword)) {
          keywords.set(seed.keyword, seed);
        }
      }
    }

    const result = [...keywords.values()].slice(0, 20);

    logger.info(`Google Trends returned ${result.length} keywords`, {
      seedKeyword,
      trendsCount: topQueries.length + risingQueries.length,
    });

    return result;
  } catch (err) {
    logger.warn("Google Trends failed, using seed template", {
      seedKeyword,
      error: err.message,
    });
    return generateSeedKeywords(category, city, services, subcategories, state);
  }
}

module.exports = {
  getKeywords,
  generateSeedKeywords,
};
