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
};
