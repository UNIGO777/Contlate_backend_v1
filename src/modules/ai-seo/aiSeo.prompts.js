/**
 * GPT prompt templates for AI-powered keyword generation and refresh.
 */

const buildGeneratePrompt = ({ businessName, category, subcategories, city, state, gbpLocationName }) => {
  const subcatStr = Array.isArray(subcategories) && subcategories.length
    ? subcategories.join(", ")
    : "N/A";

  return {
    system: `You are an expert local SEO analyst for Google Maps / Google Business Profile.
You return ONLY valid JSON. No markdown, no explanations, no code fences.`,

    user: `Business: "${businessName}"
Category: ${category || "N/A"}
Subcategories: ${subcatStr}
City: ${city || "N/A"}, ${state || ""}
GBP Location: "${gbpLocationName || businessName}"

This business just connected their Google Business Profile.
They have done ZERO months of GBP optimization.

Analyze and return JSON with exactly 15-20 keywords.
For each keyword provide:
- keyword: search term people use on Google Maps
- monthlyVolumeRange: estimated range (use ONLY: "10-50", "50-100", "100-500", "500-1K", "1K-3K", "3K-5K", "5K-10K")
- currentRankRange: where they likely rank NOW with no optimization (use ONLY: "1-3", "4-10", "10-15", "16-30", "30+", "40+")
- targetRankRange: where they can reach after 3 months of consistent work (use ONLY: "1-3", "3-7", "5-10", "5-12", "8-15", "10-20", "15-25")
- estimatedClientIncrease: new monthly clients at target rank (use ONLY: "2-5", "3-8", "5-10", "5-15", "8-15", "10-20", "15-25", "20-40", "30-60")
- isCurrentlyUsed: is this keyword likely already in their GBP? (true/false)
- priority: "high", "medium", or "low"
- category: which group (main category or subcategory name)

Also provide:
- overallScore: 1-100 (integer)
- topOpportunity: single best keyword to focus on
- summary: 2-3 line assessment of their current local SEO visibility

Return JSON shape:
{
  "overallScore": 42,
  "topOpportunity": "best dentist jaipur",
  "summary": "Your clinic has moderate visibility...",
  "keywords": [
    {
      "keyword": "dentist in jaipur",
      "monthlyVolumeRange": "1K-3K",
      "currentRankRange": "16-30",
      "targetRankRange": "3-7",
      "estimatedClientIncrease": "20-40",
      "isCurrentlyUsed": true,
      "priority": "high",
      "category": "Dentist"
    }
  ]
}`,
  };
};

const buildRefreshPrompt = ({ businessName, category, city, state, gbpLocationName, currentMonth, keywords }) => {
  const remainingMonths = 3 - currentMonth;
  const keywordsJson = JSON.stringify(
    keywords.map((k) => ({
      keyword: k.keyword,
      monthlyVolumeRange: k.monthlyVolumeRange,
      originalRankRange: k.originalRankRange,
      targetRankRange: k.targetRankRange,
      estimatedClientIncrease: k.estimatedClientIncrease,
      priority: k.priority,
    })),
    null,
    2
  );

  return {
    system: `You are an expert local SEO analyst.
You return ONLY valid JSON. No markdown, no explanations, no code fences.`,

    user: `Business: "${businessName}"
Category: ${category || "N/A"}
City: ${city || "N/A"}, ${state || ""}
GBP Location: "${gbpLocationName || businessName}"

This business has been consistently optimizing their GBP for ${currentMonth} month(s).
They started ${currentMonth} month(s) ago.
Remaining time to target: ${remainingMonths} month(s).

Here are their CURRENT keywords (do NOT change keywords, only update ranges):

${keywordsJson}

For each keyword, estimate what their rank range would be NOW
after ${currentMonth} month(s) of consistent GBP optimization.

Return JSON with:
- updatedOverallScore: new score reflecting progress (integer 1-100)
- keywords: array with each keyword having:
  - keyword: (same keyword, unchanged)
  - month${currentMonth}RankRange: estimated rank range after ${currentMonth} month(s)

Use ONLY these rank ranges: "1-3", "3-7", "4-10", "5-10", "5-12", "8-14", "8-15", "10-15", "10-20", "12-18", "12-20", "15-25", "16-30", "20-30", "30+"

Keep volume, target, client increase the SAME. Only update rank progress.

Return JSON shape:
{
  "updatedOverallScore": 55,
  "keywords": [
    {
      "keyword": "dentist in jaipur",
      "month${currentMonth}RankRange": "12-20"
    }
  ]
}`,
  };
};

module.exports = {
  buildGeneratePrompt,
  buildRefreshPrompt,
};
