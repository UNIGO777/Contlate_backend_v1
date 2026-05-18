const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const env = require("../config/env");
const logger = require("../core/logger");
const cloudinary = require("./cloudinary.service");

// ── Pricing constants ──
const GPT_INPUT_COST = 0.15 / 1_000_000; // gpt-4o-mini input
const GPT_OUTPUT_COST = 0.60 / 1_000_000; // gpt-4o-mini output
const IMAGE_PRICES = {
  low: { "1024x1024": 0.011, "1536x1024": 0.016, "1024x1536": 0.016 },
  medium: { "1024x1024": 0.042, "1536x1024": 0.063, "1024x1536": 0.063 },
  high: { "1024x1024": 0.167, "1536x1024": 0.250, "1024x1536": 0.250 },
  auto: { "1024x1024": 0.042, "1536x1024": 0.063, "1024x1536": 0.063 },
};

// ── Size metadata ──
const SIZE_MAP = {
  "1024x1024": {
    label: "Square 1:1",
    apiSize: "1024x1024",
    canvasDesc: "perfect square (1:1), 1024×1024 px",
    safeH: 1024,
    crop: false,
  },
  "4:5": {
    label: "Portrait 4:5",
    apiSize: "1024x1536",
    canvasDesc:
      "portrait rectangle (2:3), 1024×1536 px. IMPORTANT CROP: the top 10% and bottom 10% will be SLICED OFF. Treat top 10% and bottom 10% as DEAD ZONES — only decorative background, ZERO text. All text must live between 12% and 88% of image height.",
    safeH: 1280,
    crop: true,
  },
  "1024x1536": {
    label: "Portrait 2:3",
    apiSize: "1024x1536",
    canvasDesc: "portrait rectangle (2:3), 1024×1536 px",
    safeH: 1536,
    crop: false,
  },
  "1536x1024": {
    label: "Landscape 3:2",
    apiSize: "1536x1024",
    canvasDesc: "landscape rectangle (3:2), 1536×1024 px",
    safeH: 1024,
    crop: false,
  },
};

// ── Helpers ──

const callOpenAI = async (endpoint, body, isJson = true) => {
  const res = await fetch(`https://api.openai.com/v1/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.openai.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI ${endpoint} failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  return res.json();
};

const formatAddress = (business) => {
  const d = business.addressDetails || {};
  // Format: "line1, city (pincode)"
  const line = [d.line1, d.line2].filter(Boolean).join(", ");
  const cityPin = d.city && d.pincode ? `${d.city} (${d.pincode})` : (d.city || d.pincode || "");
  return [line, cityPin].filter(Boolean).join(", ") || business.address || "";
};

const formatContact = (business) => {
  return [business.phone, business.website, business.contactEmail, formatAddress(business)]
    .filter(Boolean)
    .join("  |  ");
};

const getThemeColors = (business) => {
  const theme =
    business.posterSettings?.activeTheme?.colors?.length > 0
      ? business.posterSettings.activeTheme
      : business.brandAssets?.theme;
  return theme || { name: "", colors: [], vibe: "" };
};

// ────────────────────────────────────────────────────
// 1. GENERATE MONTHLY PLAN (28-day content calendar)
// ────────────────────────────────────────────────────

const generateMonthlyPlan = async (business) => {
  const theme = getThemeColors(business);
  const prompt = `You are a social media content strategist for small businesses.

Create a 28-day social media content calendar for the business below. Each day should have a poster topic that is relevant, engaging, and varied.

Business Details:
- Name: ${business.businessName}
- Category: ${business.category || "General Business"}
- Subcategories: ${(business.subcategories || []).join(", ") || "N/A"}
- Services: ${(business.services || []).join(", ") || "N/A"}
- Description: ${business.description || "N/A"}
- Location: ${formatAddress(business)}
${business.google?.rating ? `- Google Rating: ${business.google.rating}★ (${business.google.userRatingCount} reviews)` : ""}

Content mix guidelines:
- 30% promotional (offers, discounts, new arrivals, seasonal specials)
- 25% educational (tips, how-to, industry facts, myth-busting)
- 25% brand building (about us, team spotlight, behind-the-scenes, milestones, testimonials)
- 20% engagement (questions, polls, fun facts, community events, holidays)

Return ONLY valid JSON, no markdown:
{
  "days": [
    {
      "dayNumber": 1,
      "topic": "Grand Opening / Welcome Post",
      "description": "Introduce the business with a vibrant welcome poster featuring the name, tagline, and key services",
      "contentType": "intro"
    }
  ]
}

Content types to use: "intro", "about-us", "services", "offer", "tips", "testimonial", "behind-scenes", "team", "facts", "seasonal", "engagement", "milestone", "community", "how-to", "faq"

Rules:
- Exactly 28 days
- Day 1 should always be an introduction/welcome post
- Day 2 should be about-us / our story
- Make topics specific to ${business.category || "this business"}, not generic
- Include real service names from the business where relevant
- Keep topics under 60 characters
- Keep descriptions under 150 characters`;

  const data = await callOpenAI("chat/completions", {
    model: env.openai.model,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.9,
    max_tokens: 3000,
  });

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned empty response for monthly plan");

  const parsed = JSON.parse(text);
  const days = Array.isArray(parsed.days) ? parsed.days : [];

  return {
    days: days.slice(0, 28).map((d, i) => ({
      dayNumber: i + 1,
      topic: String(d.topic || "").trim().slice(0, 100),
      description: String(d.description || "").trim().slice(0, 300),
      contentType: String(d.contentType || "general").trim(),
    })),
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
};

// ────────────────────────────────────────────────────
// 2. GENERATE POSTER PROMPT (for one day)
// ────────────────────────────────────────────────────

const buildPromptSystemMessage = (business, dayPlan, options = {}) => {
  const theme = getThemeColors(business);
  const contactStr = formatContact(business);
  const language = options.language || business.posterSettings?.defaultLanguage || "english";
  const style = options.style || business.posterSettings?.defaultStyle || "ai_decide";
  const sizeKey = options.size || business.posterSettings?.defaultSize || "4:5";
  const sizeMeta = SIZE_MAP[sizeKey] || SIZE_MAP["4:5"];
  const hasModelImg = Boolean(business.posterSettings?.useModelImage && business.posterSettings?.modelImagePath);

  let langInstruction = "ENGLISH — All poster text in English.";
  if (language === "hindi") {
    langInstruction =
      "HINDI (हिंदी) — ALL poster text (headline, tagline, offer, CTA, checklist, card content) must be written in Hindi using Devanagari script. Only the business name and contact info can remain in English.";
  } else if (language === "hinglish") {
    langInstruction =
      "HINDI + ENGLISH MIX — Use Hindi (Devanagari) for headlines, taglines, CTAs and emotional content. Use English for technical terms, business name, and contact info.";
  }

  return `You are a world-class marketing poster designer and copywriter.

Your output MUST follow this exact format:

===TEXT===
HEADLINE: [punchy, max 6 words — wildly creative, surprising, emotional or provocative]
TAGLINE: [memorable one-liner — witty, bold, or poetic, NOTHING generic]
OFFER: [compelling body copy, max 2 lines — use | to separate lines]
CTA: [2–5 word fresh action phrase specific to THIS business. NEVER: "Visit", "Contact", "Call", "today", "Get Started", "Learn More", "Shop Now"]
===CAPTION===
[Social media caption for this poster — 2-4 engaging sentences. Include a call to action. End with 8-15 relevant hashtags on a new line. Mix popular and niche hashtags. Do NOT use markdown bold or formatting.]
===PROMPT===
[Concise structured poster prompt — see rules below]

Business details:
- Business Name: ${business.businessName}
- Industry: ${business.category || "General Business"}
- Services: ${(business.services || []).join(", ") || "N/A"}
- Description: ${business.description || "N/A"}
- Today's poster topic: ${dayPlan.topic}
- Today's poster idea: ${dayPlan.description}
- Content type: ${dayPlan.contentType}
- Target Audience: general public
- Language: ${langInstruction}
- Poster format: ${sizeMeta.canvasDesc}
- Visual style & Color palette: ${style === "ai_decide" ? `YOU decide the best style. Use these brand colors as base: ${theme.colors?.join(", ") || "choose 3-4 hex codes that suit this business"}. Vibe: ${theme.vibe || "professional, modern"}` : `${style} — Use brand colors: ${theme.colors?.join(", ") || "choose appropriate colors"}`}
${contactStr ? `- Contact info to display: ${contactStr}` : "- No contact info to display"}
${hasModelImg ? "- MODEL IMAGE PROVIDED: A person/model photo will be composited into the poster." : ""}
${business.google?.rating ? `- Google Rating: ${business.google.rating}★ (${business.google.userRatingCount} reviews) — include if relevant` : ""}

STYLE RULES (CRITICAL):
1. NO markdown bold (**), NO headers with asterisks. Plain text section labels with colons.
2. Keep descriptions SHORT — one or two lines per element.
3. Write actual poster content inline (real headline text, real list items).
4. Use bullet points (• or -) for lists, ✓ for checklists.
5. Include 3-4 specific HEX color codes in the Design Style section.
6. The whole prompt should be 30-50 lines, NOT 100+.

CONTENT RULES:
1. Start with: "Create a professional [type] poster for [business] in a [style] style."
2. Then: "Canvas: [ratio], [dimensions]. Ultra high resolution, print-ready."
${sizeKey === "4:5" ? '3. Add crop warning: "CRITICAL CROP: bottom 18% and top 12% are DEAD ZONES — zero text allowed. Contact info must END by 80% height."\n' : ""}
3. Include Layout Composition, Typography, Card/Info sections, CTA, Footer, Design Style.
4. ALL text must be PERFECTLY SPELLED — especially "${business.businessName}" and contact info.
5. Make content specific to ${business.category || "this business"} and the topic "${dayPlan.topic}".

Return EXACTLY the ===TEXT=== / ===PROMPT=== format. Nothing else.`;
};

const generatePosterPrompt = async (business, dayPlan, options = {}) => {
  const systemMsg = buildPromptSystemMessage(business, dayPlan, options);

  const data = await callOpenAI("chat/completions", {
    model: env.openai.model,
    messages: [{ role: "user", content: systemMsg }],
    max_completion_tokens: 1200,
    temperature: 1.0,
  });

  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("OpenAI returned empty response for poster prompt");

  const inputTokens = data.usage?.prompt_tokens || 0;
  const outputTokens = data.usage?.completion_tokens || 0;
  const gptCost = inputTokens * GPT_INPUT_COST + outputTokens * GPT_OUTPUT_COST;

  // Parse ===TEXT===, ===CAPTION===, and ===PROMPT===
  const textMatch = raw.match(/===TEXT===([\s\S]*?)===(?:CAPTION|PROMPT)===/);
  const captionMatch = raw.match(/===CAPTION===([\s\S]*?)===PROMPT===/);
  const promptMatch = raw.match(/===PROMPT===([\s\S]*?)$/);
  const textBlock = textMatch ? textMatch[1].trim() : "";
  const caption = captionMatch ? captionMatch[1].trim() : "";
  const fullPrompt = promptMatch ? promptMatch[1].trim() : raw;

  const getField = (key) => {
    const m = textBlock.match(new RegExp(`^${key}:\\s*(.+)`, "m"));
    return m ? m[1].trim() : "";
  };

  return {
    headline: getField("HEADLINE"),
    tagline: getField("TAGLINE"),
    offer: getField("OFFER").replace(/\|/g, "\n"),
    cta: getField("CTA"),
    caption,
    fullPrompt,
    inputTokens,
    outputTokens,
    gptCost,
  };
};

// ────────────────────────────────────────────────────
// 3. GENERATE POSTER IMAGE
// ────────────────────────────────────────────────────

const buildFinalPrompt = (basePrompt, textFields, business, sizeKey) => {
  const bizName = business.businessName;
  const contactStr = formatContact(business);
  const is45 = sizeKey === "4:5";

  let final = basePrompt;

  final += `\n\n⚠️ MANDATORY TEXT — The poster MUST display ALL of these texts, spelled EXACTLY letter-by-letter:`;
  final += `\n\n1. BUSINESS NAME (largest text, top of poster): "${bizName}"`;
  if (textFields.headline) final += `\n2. HEADLINE (bold, below business name): "${textFields.headline}"`;
  if (textFields.tagline) final += `\n3. TAGLINE (stylish, middle area): "${textFields.tagline}"`;
  if (textFields.offer) final += `\n4. OFFER (clear, readable): "${textFields.offer.replace(/\n/g, " | ")}"`;
  if (textFields.cta) final += `\n5. CTA BUTTON (eye-catching button shape): "${textFields.cta}"`;
  if (contactStr) final += `\n6. CONTACT INFO (small text, bottom of poster): ${contactStr}`;
  final += `\n\nDo NOT skip any text element. Do NOT paraphrase. Do NOT add extra text. Spell "${bizName}" EXACTLY as shown.`;

  if (is45) {
    final += `\n\n⚠️ CRITICAL CROP WARNING: The top 128px (10%) and bottom 128px (10%) of this 1024×1536 image will be COMPLETELY SLICED OFF to make a 1024×1280 poster.`;
    final += `\nABSOLUTE RULES:`;
    final += `\n- ZERO text, logos, or contact info in the top 12% or bottom 18% of the image.`;
    final += `\n- Business name must start at ~14% from top.`;
    final += `\n- Contact info / footer must END by 80% from top — leave the bottom 20% as ONLY solid background color or gradient.`;
    final += `\n- The CTA button must be fully above the 78% mark.`;
    final += `\n- If you place ANY text below 80% it WILL be cropped and invisible. This is non-negotiable.`;
  }

  return final;
};

const generatePosterImage = async (
  prompt,
  textFields,
  business,
  { size = "4:5", quality, modelImageBuffer = null } = {}
) => {
  // Effort level from .env overrides everything; fall back to passed quality or "low"
  const effort = env.openai.imageEffort || quality || "low";
  const sizeMeta = SIZE_MAP[size] || SIZE_MAP["4:5"];
  const apiSize = sizeMeta.apiSize;
  const finalPrompt = buildFinalPrompt(prompt, textFields, business, size);

  let data;

  if (modelImageBuffer) {
    // Use edits endpoint with model image
    const FormData = (await import("node-fetch")).default ? null : null;
    // BullMQ workers run in Node — use native fetch with FormData
    const formData = new globalThis.FormData();
    formData.append("model", "gpt-image-2");
    formData.append("prompt", finalPrompt);
    formData.append("n", "1");
    formData.append("size", apiSize);
    formData.append("quality", effort);
    formData.append(
      "image[]",
      new Blob([modelImageBuffer], { type: "image/png" }),
      "model.png"
    );

    const res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.openai.apiKey}` },
      body: formData,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`gpt-image-2 edits failed (${res.status}): ${errText.slice(0, 300)}`);
    }
    data = await res.json();
  } else {
    // Use generations endpoint
    data = await callOpenAI("images/generations", {
      model: "gpt-image-2",
      prompt: finalPrompt,
      n: 1,
      size: apiSize,
      quality: effort,
    });
  }

  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("gpt-image-2 returned no image data");

  let imageBuffer = Buffer.from(b64, "base64");

  // Crop to 4:5 if needed (1024x1536 → 1024x1280)
  if (sizeMeta.crop) {
    const outW = 1024;
    const outH = 1280;
    const srcH = 1536;
    const offsetY = Math.round((srcH - outH) / 2);
    imageBuffer = await sharp(imageBuffer)
      .extract({ left: 0, top: offsetY, width: outW, height: outH })
      .png()
      .toBuffer();
  }

  const imageCost = IMAGE_PRICES[effort]?.[apiSize] || 0.011;

  return {
    imageBuffer,
    imageCost,
    revisedPrompt: finalPrompt,
    apiSize,
    quality: effort,
  };
};

// ────────────────────────────────────────────────────
// 4. SAVE POSTER LOCALLY
// ────────────────────────────────────────────────────

const savePosterLocally = async (imageBuffer, businessId, dayIdentifier) => {
  const dir = path.resolve(env.storageLocalDir, "posters", String(businessId));
  await fs.mkdir(dir, { recursive: true });

  const filename = `${dayIdentifier}_${Date.now()}.png`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, imageBuffer);

  const publicUrl = `${env.storagePublicBaseUrl}/files/posters/${businessId}/${filename}`;
  return { localPath: filePath, publicUrl };
};

// ────────────────────────────────────────────────────
// 5. DELETE LOCAL POSTER
// ────────────────────────────────────────────────────

const deleteLocalPoster = async (localPath) => {
  if (!localPath) return;
  try {
    await fs.unlink(localPath);
    logger.info("[poster] deleted local file", { path: localPath });
  } catch (err) {
    if (err.code !== "ENOENT") {
      logger.warn("[poster] failed to delete local file", { path: localPath, error: err.message });
    }
  }
};

// ────────────────────────────────────────────────────
// 6. READ MODEL IMAGE FROM DISK
// ────────────────────────────────────────────────────

const readModelImageBuffer = async (modelImagePath) => {
  if (!modelImagePath) return null;
  try {
    return await fs.readFile(modelImagePath);
  } catch (err) {
    logger.warn("[poster] model image not found", { path: modelImagePath, error: err.message });
    return null;
  }
};

// ────────────────────────────────────────────────────
// 7. WELCOME POSTER TEMPLATES
// ────────────────────────────────────────────────────

const WELCOME_TEMPLATES = {
  intro: (business) => ({
    topic: `Introducing ${business.businessName}`,
    description: `Grand introduction poster — welcoming customers with business name, category, tagline, and contact info`,
    contentType: "intro",
  }),
  "about-us": (business) => ({
    topic: `About ${business.businessName} — Our Story`,
    description: `About us poster featuring brand story, top services, ${business.google?.rating ? `Google rating ${business.google.rating}★,` : ""} and contact details`,
    contentType: "about-us",
  }),
};

const getWelcomeTemplate = (type, business) => {
  const fn = WELCOME_TEMPLATES[type];
  if (!fn) throw new Error(`Unknown welcome poster type: ${type}`);
  return fn(business);
};

module.exports = {
  SIZE_MAP,
  IMAGE_PRICES,
  GPT_INPUT_COST,
  GPT_OUTPUT_COST,
  generateMonthlyPlan,
  generatePosterPrompt,
  generatePosterImage,
  buildFinalPrompt,
  savePosterLocally,
  deleteLocalPoster,
  readModelImageBuffer,
  getWelcomeTemplate,
  formatAddress,
  formatContact,
  getThemeColors,
};
