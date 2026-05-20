const env = require("../../config/env");
const logger = require("../../core/logger");
const AiSeo = require("./aiSeo.model");
const GbpAccount = require("../seo/gbpAccount.model");
const Business = require("../business/business.model");
const { buildGeneratePrompt, buildRefreshPrompt } = require("./aiSeo.prompts");

const stripCodeFence = (text = "") =>
  text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

const safeJsonParse = (text = "") => {
  const clean = stripCodeFence(text);
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error("OpenAI returned invalid JSON.");
  }
};

const callOpenAI = async (systemPrompt, userPrompt) => {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.openai.apiKey}`,
    },
    body: JSON.stringify({
      model: env.openai.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
      max_tokens: 3000,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    logger.warn("[ai-seo] OpenAI request failed", {
      status: res.status,
      body: errText.slice(0, 400),
    });
    throw new Error(`OpenAI request failed (${res.status})`);
  }

  const json = await res.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned an empty response.");

  return safeJsonParse(text);
};

/**
 * Check if a business has GBP connected (with a selected location).
 */
const checkGbpConnected = async (businessId) => {
  const gbp = await GbpAccount.findOne({
    businessId,
    status: "connected",
    gbpLocationId: { $ne: "" },
  }).lean();
  return gbp;
};

/**
 * Generate initial keywords for a business (Month 0).
 */
const generateKeywords = async (userId, businessId) => {
  const business = await Business.findById(businessId).lean();
  if (!business) throw new Error("Business not found.");

  const gbp = await checkGbpConnected(businessId);
  if (!gbp) throw new Error("GBP not connected. Connect your Google Business Profile first.");

  // Check if already generated
  const existing = await AiSeo.findOne({ businessId });
  if (existing && existing.status === "ready") {
    return existing;
  }

  // Create or update record as "generating"
  let record = await AiSeo.findOneAndUpdate(
    { businessId },
    {
      $set: {
        userId,
        businessId,
        status: "generating",
        lastError: "",
      },
    },
    { upsert: true, new: true }
  );

  try {
    const prompt = buildGeneratePrompt({
      businessName: business.businessName,
      category: business.category,
      subcategories: business.subcategories,
      city: business.addressDetails?.city || "",
      state: business.addressDetails?.state || "",
      gbpLocationName: gbp.gbpLocationName,
    });

    const result = await callOpenAI(prompt.system, prompt.user);

    const keywords = (result.keywords || []).slice(0, 20).map((k) => ({
      keyword: k.keyword || "",
      monthlyVolumeRange: k.monthlyVolumeRange || "",
      originalRankRange: k.currentRankRange || "",
      targetRankRange: k.targetRankRange || "",
      estimatedClientIncrease: k.estimatedClientIncrease || "",
      isCurrentlyUsed: Boolean(k.isCurrentlyUsed),
      priority: ["high", "medium", "low"].includes(k.priority) ? k.priority : "medium",
      category: k.category || "",
      workOnIt: true,
      status: "active",
      addedAt: new Date(),
    }));

    record = await AiSeo.findOneAndUpdate(
      { businessId },
      {
        $set: {
          overallScore: Math.min(100, Math.max(0, result.overallScore || 0)),
          topOpportunity: result.topOpportunity || "",
          summary: result.summary || "",
          cycleNumber: record.cycleNumber || 1,
          cycleStartedAt: new Date(),
          currentMonth: 0,
          lastRefreshedAt: new Date(),
          keywords,
          status: "ready",
          lastError: "",
        },
      },
      { new: true }
    );

    logger.info("[ai-seo] keywords generated", {
      businessId,
      keywordCount: keywords.length,
      score: record.overallScore,
    });

    return record;
  } catch (err) {
    await AiSeo.findOneAndUpdate(
      { businessId },
      { $set: { status: "error", lastError: err.message } }
    );
    throw err;
  }
};

/**
 * Monthly refresh — update rank ranges for existing keywords.
 */
const refreshKeywords = async (businessId) => {
  const record = await AiSeo.findOne({ businessId });
  if (!record || record.status !== "ready") {
    throw new Error("No keyword data found. Generate keywords first.");
  }

  if (record.currentMonth >= 3) {
    throw new Error("Cycle complete. Start a new cycle to continue tracking.");
  }

  const nextMonth = record.currentMonth + 1;

  const business = await Business.findById(businessId).lean();
  if (!business) throw new Error("Business not found.");

  const gbp = await checkGbpConnected(businessId);

  const activeKeywords = record.keywords.filter((k) => k.workOnIt && k.status === "active");

  const prompt = buildRefreshPrompt({
    businessName: business.businessName,
    category: business.category,
    city: business.addressDetails?.city || "",
    state: business.addressDetails?.state || "",
    gbpLocationName: gbp?.gbpLocationName || "",
    currentMonth: nextMonth,
    keywords: activeKeywords,
  });

  const result = await callOpenAI(prompt.system, prompt.user);

  // Build lookup from GPT response
  const rankLookup = {};
  for (const k of result.keywords || []) {
    const rankField = `month${nextMonth}RankRange`;
    rankLookup[k.keyword.toLowerCase()] = k[rankField] || "";
  }

  // Update each keyword
  const updatedKeywords = record.keywords.map((k) => {
    const kw = k.toObject ? k.toObject() : { ...k };
    if (!kw.workOnIt || kw.status !== "active") return kw;

    const newRank = rankLookup[kw.keyword.toLowerCase()] || "";
    const rankField = `month${nextMonth}RankRange`;
    kw[rankField] = newRank;

    // If month 3, mark as completed
    if (nextMonth === 3 && newRank) {
      kw.status = "completed";
    }

    return kw;
  });

  const updated = await AiSeo.findOneAndUpdate(
    { businessId },
    {
      $set: {
        keywords: updatedKeywords,
        currentMonth: nextMonth,
        overallScore: Math.min(100, Math.max(0, result.updatedOverallScore || record.overallScore)),
        lastRefreshedAt: new Date(),
      },
    },
    { new: true }
  );

  logger.info("[ai-seo] keywords refreshed", {
    businessId,
    month: nextMonth,
    score: updated.overallScore,
  });

  return updated;
};

/**
 * Toggle workOnIt for a keyword (Advanced plan only).
 * At least 5 keywords must remain active.
 */
const toggleKeywordWorkOnIt = async (businessId, keywordIndex, workOnIt) => {
  const record = await AiSeo.findOne({ businessId });
  if (!record) throw new Error("No keyword data found.");

  if (keywordIndex < 0 || keywordIndex >= record.keywords.length) {
    throw new Error("Invalid keyword index.");
  }

  // If disabling, check minimum active count
  if (!workOnIt) {
    const activeCount = record.keywords.filter(
      (k, i) => k.workOnIt && i !== keywordIndex
    ).length;
    if (activeCount < 5) {
      throw new Error("You must keep at least 5 keywords active.");
    }
  }

  record.keywords[keywordIndex].workOnIt = workOnIt;
  await record.save();

  return record;
};

/**
 * Start a new 3-month cycle after completion.
 * Moves current keywords to completedKeywords, generates fresh ones.
 */
const startNewCycle = async (userId, businessId) => {
  const record = await AiSeo.findOne({ businessId });
  if (!record) throw new Error("No keyword data found.");

  // Move completed keywords to history
  const completedEntries = record.keywords
    .filter((k) => k.status === "completed")
    .map((k) => ({
      keyword: k.keyword,
      monthlyVolumeRange: k.monthlyVolumeRange,
      originalRankRange: k.originalRankRange,
      finalRankRange: k.month3RankRange || k.month2RankRange || k.month1RankRange || "",
      estimatedClientIncrease: k.estimatedClientIncrease,
      cycleNumber: record.cycleNumber,
      completedAt: new Date(),
    }));

  await AiSeo.findOneAndUpdate(
    { businessId },
    {
      $push: { completedKeywords: { $each: completedEntries } },
      $set: {
        cycleNumber: record.cycleNumber + 1,
        currentMonth: 0,
        keywords: [],
        status: "generating",
      },
    }
  );

  // Generate new keywords
  return generateKeywords(userId, businessId);
};

/**
 * Get insights for a business.
 */
const getInsights = async (businessId) => {
  const record = await AiSeo.findOne({ businessId }).lean();
  return record || null;
};

module.exports = {
  checkGbpConnected,
  generateKeywords,
  refreshKeywords,
  toggleKeywordWorkOnIt,
  startNewCycle,
  getInsights,
};
