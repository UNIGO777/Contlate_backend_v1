const googleTrends = require("google-trends-api");
const logger = require("../core/logger");

/**
 * Generate seed keywords for a single term (category or subcategory).
 * Returns up to `maxCount` template keywords.
 */
function generateSeedForTerm(term, city, state = "", maxCount = 5) {
  const t = term.toLowerCase().trim();
  const cty = city.toLowerCase().trim();
  const st = state ? state.toLowerCase().trim() : "";

  const templates = [
    `${t} in ${cty}`,
    `${t} near me`,
    `best ${t} ${cty}`,
    `${t} ${cty}`,
    st ? `${t} ${cty} ${st}` : null,
    `${t} open now`,
    `${t} appointment ${cty}`,
    `affordable ${t} ${cty}`,
    `top rated ${t} ${cty}`,
  ].filter(Boolean);

  return templates.slice(0, maxCount).map((keyword) => ({
    keyword,
    trendValue: null,
    isRising: null,
    source: "template",
  }));
}

/**
 * Generate seed keywords distributed across category + subcategories.
 *
 * E.g. 20 keywords, 1 category + 4 subcategories = 5 groups → 4 keywords each.
 * Returns: [{ group, groupType, keywords[] }]
 */
function generateGroupedSeedKeywords(category, city, subcategories = [], state = "", totalKeywords = 20) {
  const groups = [category, ...subcategories.filter((s) => s && s.trim())];
  const perGroup = Math.floor(totalKeywords / groups.length);
  const remainder = totalKeywords % groups.length;

  const result = [];

  for (let i = 0; i < groups.length; i++) {
    const isCategory = i === 0;
    // Distribute remainder to first groups
    const count = perGroup + (i < remainder ? 1 : 0);

    const keywords = generateSeedForTerm(groups[i], city, state, count);

    result.push({
      group: groups[i],
      groupType: isCategory ? "category" : "subcategory",
      keywords,
    });
  }

  return result;
}

/**
 * Legacy flat seed keyword generator (kept for backward compat).
 * Internally uses the grouped generator and flattens.
 */
function generateSeedKeywords(category, city, services = [], subcategories = [], state = "") {
  const grouped = generateGroupedSeedKeywords(category, city, subcategories, state, 20);
  return grouped.flatMap((g) =>
    g.keywords.map((kw) => ({ ...kw, group: g.group, groupType: g.groupType }))
  );
}

/**
 * Try to get related + rising keywords from Google Trends for a single term.
 * Returns flat keyword array (no group metadata — caller assigns that).
 * Falls back to seed template if anything goes wrong.
 */
async function getTrendsForTerm(term, city, maxCount = 20) {
  const seedKeyword = `${term} ${city}`;

  try {
    const relatedRaw = await googleTrends.relatedQueries({
      keyword: seedKeyword,
      geo: "IN",
    });

    const relatedData = JSON.parse(relatedRaw);
    const defaultNode = relatedData?.default;

    if (!defaultNode || !defaultNode.rankedList || defaultNode.rankedList.length === 0) {
      return null; // caller will use template fallback
    }

    const keywords = new Map();
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
        keywords.set(kw, {
          keyword: kw,
          trendValue: item.value || 0,
          isRising: true,
          source: "google_trends",
        });
      }
    }

    if (keywords.size === 0) return null;
    return [...keywords.values()].slice(0, maxCount);
  } catch (err) {
    logger.warn("Google Trends failed for term", { term, city, error: err.message });
    return null;
  }
}

/**
 * Get keywords distributed across category + subcategories.
 * For each group: try Google Trends first, fall back to templates.
 * Returns: [{ group, groupType, keywords[] }]
 */
async function getGroupedKeywords(category, city, subcategories = [], state = "", totalKeywords = 20) {
  const groups = [category, ...subcategories.filter((s) => s && s.trim())];
  const perGroup = Math.floor(totalKeywords / groups.length);
  const remainder = totalKeywords % groups.length;

  const result = [];

  for (let i = 0; i < groups.length; i++) {
    const isCategory = i === 0;
    const count = perGroup + (i < remainder ? 1 : 0);
    const term = groups[i];

    // Try Google Trends for this group
    let keywords = await getTrendsForTerm(term, city, count);

    if (!keywords || keywords.length < count) {
      // Pad or replace with templates
      const templates = generateSeedForTerm(term, city, state, count);
      if (!keywords) {
        keywords = templates;
      } else {
        // Pad with templates that aren't duplicates
        const existing = new Set(keywords.map((k) => k.keyword));
        for (const tpl of templates) {
          if (keywords.length >= count) break;
          if (!existing.has(tpl.keyword)) {
            keywords.push(tpl);
          }
        }
      }
    }

    // Trim to exact count
    keywords = keywords.slice(0, count);

    result.push({
      group: term,
      groupType: isCategory ? "category" : "subcategory",
      keywords,
    });
  }

  logger.info("Grouped keywords generated", {
    category,
    city,
    groups: result.map((g) => `${g.groupType}:${g.group}(${g.keywords.length})`),
    total: result.reduce((s, g) => s + g.keywords.length, 0),
  });

  return result;
}

/**
 * Legacy flat getKeywords — kept for backward compat.
 */
async function getKeywords(category, city, services = [], subcategories = [], state = "") {
  const grouped = await getGroupedKeywords(category, city, subcategories, state, 20);
  return grouped.flatMap((g) =>
    g.keywords.map((kw) => ({ ...kw, group: g.group, groupType: g.groupType }))
  );
}

module.exports = {
  getKeywords,
  getGroupedKeywords,
  getTrendsForTerm,
  generateSeedKeywords,
  generateGroupedSeedKeywords,
  generateSeedForTerm,
};
