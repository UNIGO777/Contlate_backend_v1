const env = require("../config/env");
const logger = require("../core/logger");

const isConfigured = () => Boolean(env.openai.apiKey);

const SYSTEM_PROMPT = `You are a senior copywriter for Postly, a social-media automation tool used by small businesses.
You write brand stories that are warm, specific, and human — never marketing-speak.

Rules:
- 4–6 sentences, 80–140 words.
- Open with the business name and what they do.
- Mention 1–2 concrete things that make them distinctive (location, speciality, history, values).
- Close with what customers walk away with — a feeling or outcome.
- Plain prose, no bullet points, no emoji, no hashtags, no quotation marks around the whole thing.
- Voice: confident, friendly, slightly literary. Avoid "passionate", "dedicated", "exceptional", "best-in-class".
- Output ONLY the brand story — no preamble like "Here's your description:".`;

const buildUserPrompt = (input) => {
  const lines = [];
  if (input.businessName) lines.push(`Business name: ${input.businessName}`);
  if (input.category)     lines.push(`Category: ${input.category}`);
  if (input.subcategories?.length) lines.push(`Specialities: ${input.subcategories.join(", ")}`);
  if (input.address || input.city) lines.push(`Location: ${[input.address, input.city, input.country].filter(Boolean).join(", ")}`);
  if (input.phone)        lines.push(`Phone: ${input.phone}`);

  if (input.googlePlace) {
    const g = input.googlePlace;
    if (g.displayName)      lines.push(`Verified name (Google): ${g.displayName}`);
    if (g.formattedAddress) lines.push(`Verified address (Google): ${g.formattedAddress}`);
    if (g.primaryType || g.types?.length) lines.push(`Google type: ${g.primaryType || g.types?.[0]}`);
    if (g.rating)           lines.push(`Google rating: ${g.rating}★`);
    if (g.userRatingCount)  lines.push(`Reviews: ${g.userRatingCount}`);
  }

  if (input.description?.trim()) {
    lines.push(``);
    lines.push(`Founder's own words (paraphrase, don't quote verbatim):`);
    lines.push(input.description.trim());
  }

  return lines.join("\n");
};

const BUSINESS_PROFILE_SYSTEM_PROMPT = `You classify local business profiles for Postly.
Return concise JSON only. No markdown. No explanations.

JSON shape:
{
  "category": "one broad business category",
  "subcategories": ["4 to 10 short positioning tags"],
  "services": ["3 to 12 concrete services/products customers can buy or request"],
  "description": "2 to 4 customer-facing sentences"
}

Rules:
- Prefer a clear category like Restaurant, Cafe, Salon, Gym, Clinic, Retail Store, Coaching, Real Estate, or Professional Services when appropriate.
- Use Google place types, primary type, editorial summary, website, rating, address, phone, and opening hours as evidence.
- Services must be concrete offerings, not generic traits. Examples: Home Delivery, Haircut, Property Consultation, Lab Tests.
- Keep every category, subcategory, and service under 32 characters.
- Do not invent sensitive claims, prices, guarantees, awards, or exact opening hours unless explicitly provided.`;

const compactGooglePlace = (googlePlace = {}) => ({
  name: googlePlace.displayName || googlePlace.name || "",
  formattedAddress: googlePlace.formattedAddress || "",
  website: googlePlace.website || "",
  internationalPhoneNumber: googlePlace.internationalPhoneNumber || "",
  rating: googlePlace.rating ?? null,
  userRatingCount: googlePlace.userRatingCount ?? null,
  googleMapsUri: googlePlace.googleMapsUri || "",
  businessStatus: googlePlace.businessStatus || "",
  types: Array.isArray(googlePlace.types) ? googlePlace.types : [],
  primaryType: googlePlace.primaryType || "",
  primaryTypeDisplayName: googlePlace.primaryTypeDisplayName || "",
  editorialSummary: googlePlace.editorialSummary || "",
  regularOpeningHours: googlePlace.regularOpeningHours || null,
  location: googlePlace.location || null,
});

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

const cleanList = (value, max) =>
  (Array.isArray(value) ? value : [])
    .map((item) => String(item).trim())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index)
    .slice(0, max);

const normalizeBusinessProfileSuggestions = (raw = {}) => ({
  category: typeof raw.category === "string" ? raw.category.trim().slice(0, 60) : "",
  subcategories: cleanList(raw.subcategories, 10),
  services: cleanList(raw.services, 12),
  description:
    typeof raw.description === "string" ? raw.description.trim().slice(0, 1500) : "",
  source: "openai",
});

const buildBusinessProfilePrompt = (input = {}) =>
  JSON.stringify(
    {
      businessName: input.businessName || "",
      phone: input.phone || "",
      address: input.address || "",
      addressDetails: input.addressDetails || {},
      currentCategory: input.category || "",
      currentSubcategories: input.subcategories || [],
      currentServices: input.services || [],
      currentDescription: input.description || "",
      googlePlace: input.googlePlace ? compactGooglePlace(input.googlePlace) : null,
    },
    null,
    2
  );

const generateBusinessProfileSuggestions = async (input = {}) => {
  if (!isConfigured()) throw new Error("OpenAI is not configured (OPENAI_API_KEY missing).");

  const body = {
    model: env.openai.model,
    messages: [
      { role: "system", content: BUSINESS_PROFILE_SYSTEM_PROMPT },
      { role: "user", content: buildBusinessProfilePrompt(input) },
    ],
    response_format: { type: "json_object" },
    temperature: 0.25,
    max_tokens: 520,
  };

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
    logger.warn("[openai] profile-suggestions request failed", {
      status: res.status,
      body: errText.slice(0, 400),
    });
    throw new Error(`OpenAI request failed (${res.status})`);
  }

  const json = await res.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned an empty response.");

  return normalizeBusinessProfileSuggestions(safeJsonParse(text));
};

const generateBrandStory = async (input = {}) => {
  if (!isConfigured()) throw new Error("OpenAI is not configured (OPENAI_API_KEY missing).");

  const userPrompt = buildUserPrompt(input);
  if (!userPrompt) throw new Error("Need at least a business name to generate a brand story.");

  const body = {
    model: env.openai.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: userPrompt },
    ],
    temperature: 0.75,
    max_tokens: 260,
  };

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
    logger.warn("[openai] brand-story request failed", { status: res.status, body: errText.slice(0, 400) });
    throw new Error(`OpenAI request failed (${res.status})`);
  }

  const json = await res.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned an empty response.");

  return text;
};

module.exports = {
  isConfigured,
  generateBrandStory,
  generateBusinessProfileSuggestions,
};
