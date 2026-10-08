/**
 * Phase 4 — 28-Day Plan Generation Service
 *
 * Uses OpenAI (gpt-4o-mini) to generate 26 poster concepts for Days 3–28.
 * Days 1 and 2 are always fixed: "Intro" and "About Us".
 *
 * STRICT rules from plan.md:
 *  - Never invent offers or products — only use what the user provided.
 *  - If businessOffers is null/empty, do not create offer-based posts.
 *  - All titles and descriptions must be grounded in real user data.
 */

const env = require("../config/env");
const logger = require("../core/logger");

// ── Fixed days ────────────────────────────────────────────────────────────────
const FIXED_DAYS = [
  { day: 1, title: "Intro",    description: "Introduce your business — who you are, what you do, and why customers should care." },
  { day: 2, title: "About Us", description: "Share your team's story, values, and what makes your business special." },
];

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a social-media content strategist for Prachar, a scheduling tool for small businesses.
Your job is to plan 26 poster concepts for Days 3 to 28 of a 28-day content calendar.

STRICT RULES (never break these):
1. Every post must be grounded in the business data provided. No imaginary products, services, or offers.
2. If no offers are provided, DO NOT create offer-based posts (e.g. "20% off", "limited deal").
3. If only service businesses data is provided, do not create product-based posts and vice versa.
4. Vary the content types: mix service/product highlights, testimonial prompts, tips, behind-the-scenes, FAQs, seasonal, etc.
5. Each title must be short (2–5 words), punchy, and unique across all 26 days.
6. Each description must be 1–2 sentences that give the AI image generator clear direction.
7. Return ONLY valid JSON — an array of exactly 26 objects. No markdown. No preamble.
8. You will receive the exact date for each day and the user's country.
   If any national holiday, festival, or well-known occasion falls on a day,
   make that day's post occasion-themed while connecting it to the business.
   Examples:
   - Day on Aug 15 + country India → "Independence Day Special" — celebrate the occasion while promoting the business.
   - Day on Dec 25 → "Christmas Cheer" — festive post related to the business.
   - Day on Diwali → "Diwali Celebration" — festive offer or greeting tied to the business.
   Only use real, widely celebrated occasions for that country. Do NOT force occasions where there are none.

JSON format (Days 3–28):
[
  { "day": 3, "date": "YYYY-MM-DD", "title": "...", "description": "..." },
  ...
  { "day": 28, "date": "YYYY-MM-DD", "title": "...", "description": "..." }
]`;

// ── Build user prompt from business data ──────────────────────────────────────
function buildUserPrompt(business, offers, cycleStartDate, country) {
  const lines = [];

  lines.push(`Business name: ${business.businessName}`);
  if (business.category) lines.push(`Category: ${business.category}`);
  if (business.subcategories?.length) lines.push(`Specialties: ${business.subcategories.join(", ")}`);
  if (business.description?.trim()) lines.push(`About: ${business.description.trim()}`);
  lines.push(`Country: ${country || "Unknown"}`);

  // Add actual dates for each of the 28 days so GPT can plan around occasions
  if (cycleStartDate) {
    lines.push("\nContent calendar dates (post dates):");
    for (let day = 1; day <= 28; day++) {
      const d = new Date(cycleStartDate);
      d.setDate(d.getDate() + day + 1); // +day for generation, +1 for post day
      const dateStr = d.toISOString().split("T")[0];
      const label = day <= 2 ? " (fixed — skip)" : "";
      lines.push(`  Day ${day} (${dateStr})${label}`);
    }
  }

  if (!offers) {
    lines.push("\nBusiness type: unknown — use general service-business content.");
    lines.push("No offers provided — DO NOT include any offer or discount posts.");
    return lines.join("\n");
  }

  lines.push(`\nBusiness type: ${offers.businessType}`);

  if (offers.businessType === "product" && offers.products?.length) {
    lines.push("\nProducts:");
    offers.products.forEach((p) => {
      let line = `  - ${p.name}`;
      if (p.description) line += `: ${p.description}`;
      if (p.price) line += ` (₹${p.price})`;
      if (p.offer?.name) {
        line += ` | Offer: "${p.offer.name}"`;
        if (p.offer.discount) line += ` ${p.offer.discount}% off`;
        if (p.offer.validFrom && p.offer.validTo) line += ` (${p.offer.validFrom} – ${p.offer.validTo})`;
      }
      lines.push(line);
    });
    const hasOffers = offers.products.some((p) => p.offer?.name);
    if (!hasOffers) lines.push("Note: No current offers — DO NOT create offer-based posts.");
  } else if (offers.businessType === "service" && offers.services?.length) {
    lines.push("\nServices:");
    offers.services.forEach((s) => {
      let line = `  - ${s.name}`;
      if (s.description) line += `: ${s.description}`;
      if (s.offer?.name) {
        line += ` | Offer: "${s.offer.name}"`;
        if (s.offer.discount) line += ` ${s.offer.discount}% off`;
        if (s.offer.validFrom && s.offer.validTo) line += ` (${s.offer.validFrom} – ${s.offer.validTo})`;
      }
      lines.push(line);
    });
    const hasOffers = offers.services.some((s) => s.offer?.name);
    if (!hasOffers) lines.push("Note: No current offers — DO NOT create offer-based posts.");
  } else {
    lines.push("No products or services listed — use general business content only. DO NOT invent offers.");
  }

  return lines.join("\n");
}

// ── Parse and validate AI response ───────────────────────────────────────────
const stripCodeFence = (text = "") =>
  text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

function parseAIConcepts(raw) {
  const clean = stripCodeFence(raw);
  let arr;
  try {
    arr = JSON.parse(clean);
  } catch {
    // Try extracting JSON array from response
    const start = clean.indexOf("[");
    const end = clean.lastIndexOf("]");
    if (start >= 0 && end > start) arr = JSON.parse(clean.slice(start, end + 1));
    else throw new Error("AI returned invalid JSON for plan concepts.");
  }

  if (!Array.isArray(arr)) throw new Error("AI plan response is not an array.");

  // Validate and normalize
  return arr
    .filter((item) => item && typeof item.day === "number" && item.title && item.description)
    .map((item) => ({
      day: item.day,
      title: String(item.title).trim().slice(0, 80),
      description: String(item.description).trim().slice(0, 400),
    }))
    .filter((item) => item.day >= 3 && item.day <= 28)
    .sort((a, b) => a.day - b.day)
    .slice(0, 26);
}

// ── Fill missing days with generic fallback ───────────────────────────────────
const GENERIC_FALLBACKS = [
  "Behind the Scenes",   "Happy Customers",     "Our Process",
  "Quick Tips",          "Did You Know?",        "Team Spotlight",
  "Why Choose Us",       "Customer Story",       "Day in Our Life",
  "Product/Service Highlight", "FAQ Friday",     "Special Feature",
  "Community Post",      "Fun Fact",            "Client Win",
  "Expert Advice",       "Before & After",      "Staff Pick",
  "Monthly Recap",       "Milestone Moment",    "How It Works",
  "What We Stand For",   "Customer Love",       "Free Tip",
  "Our Promise",         "Stay Connected",
];

function fillMissingDays(concepts) {
  const result = [...concepts];
  const existingDays = new Set(result.map((c) => c.day));
  let fallbackIdx = 0;
  for (let day = 3; day <= 28; day++) {
    if (!existingDays.has(day)) {
      result.push({
        day,
        title: GENERIC_FALLBACKS[fallbackIdx % GENERIC_FALLBACKS.length],
        description: "Create an engaging post that showcases your business and builds audience trust.",
      });
      fallbackIdx++;
    }
  }
  return result.sort((a, b) => a.day - b.day);
}

// ── Main: call OpenAI and return full 28 concepts ─────────────────────────────
async function generatePlanConcepts(business, offers, cycleStartDate, country) {
  if (!env.openai.apiKey) {
    logger.warn("[planGeneration] OPENAI_API_KEY not set — using fallback concepts.");
    const fallback = fillMissingDays([]);
    return [...FIXED_DAYS, ...fallback];
  }

  const userPrompt = buildUserPrompt(business, offers, cycleStartDate, country);

  const body = {
    model: env.openai.model || "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: userPrompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.6,
    max_tokens: 3000,
  };

  let concepts26 = [];
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.openai.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      logger.warn("[planGeneration] OpenAI request failed", { status: res.status, body: errText.slice(0, 400) });
      throw new Error(`OpenAI request failed (${res.status})`);
    }

    const json = await res.json();
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("OpenAI returned empty response.");

    // OpenAI json_object mode returns an object — look for the array inside
    let rawArr = text;
    try {
      const parsed = JSON.parse(stripCodeFence(text));
      // Could be { days: [...] } or { plan: [...] } or just [...]
      if (Array.isArray(parsed)) rawArr = text;
      else {
        const arrKey = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
        rawArr = arrKey ? JSON.stringify(parsed[arrKey]) : text;
      }
    } catch { /* use rawArr as-is */ }

    concepts26 = parseAIConcepts(rawArr);
  } catch (err) {
    logger.error("[planGeneration] Failed to generate AI concepts", { error: err.message });
    concepts26 = [];
  }

  const filledConcepts = fillMissingDays(concepts26);
  return [...FIXED_DAYS, ...filledConcepts];
}

// ── Build the 28 day documents ────────────────────────────────────────────────
/**
 * @param {object[]} concepts         - 28 { day, title, description } objects
 * @param {Date}     cycleStartDate   - Plan start date (today at midnight)
 * @param {string}   autoPostTime     - "HH:MM" (24-hour), user's chosen post time
 * @returns {object[]} - 28 day sub-documents ready for ContentPlan
 */
function buildDayDocuments(concepts, cycleStartDate, autoPostTime) {
  const [postHour, postMin] = autoPostTime.split(":").map(Number);

  return concepts.map(({ day, title, description }) => {
    // Image generates at midnight of (cycleStartDate + day days)
    // e.g. Day 1 generates at midnight of day 1 of the cycle
    const generationDay = new Date(cycleStartDate);
    generationDay.setDate(generationDay.getDate() + day);   // day 1 → +1 day
    generationDay.setHours(0, 0, 0, 0);

    // Auto-posts at user's time on the day after generation
    const postDay = new Date(generationDay);
    postDay.setDate(postDay.getDate() + 1);
    postDay.setHours(postHour, postMin, 0, 0);

    // Decline deadline = 2 hours before auto-post
    const declineDeadline = new Date(postDay.getTime() - 2 * 60 * 60 * 1000);

    return {
      dayNumber: day,
      date: generationDay,
      topic: title,
      title,
      description,
      planStatus: "concept",
      promptStatus: "pending",
      imageStatus: "pending",
      scheduledGenerationAt: generationDay,
      scheduledPostAt: postDay,
      declineDeadlineAt: declineDeadline,
    };
  });
}

module.exports = { generatePlanConcepts, buildDayDocuments };
