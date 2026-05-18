const trimStr = (v) => (typeof v === "string" ? v.trim() : "");

const VALID_SIZES = ["1024x1024", "4:5", "1024x1536", "1536x1024"];
const VALID_QUALITIES = ["auto", "low", "medium", "high"];
const VALID_LANGUAGES = ["english", "hindi", "hinglish"];
const VALID_STYLES = [
  "ai_decide",
  "modern minimalist",
  "bold and vibrant",
  "luxury and elegant",
  "playful and fun",
  "retro vintage",
  "corporate professional",
  "artistic and creative",
  "dark and dramatic",
];

const normalizeTheme = (theme) => {
  if (!theme || typeof theme !== "object") return undefined;
  return {
    name: typeof theme.name === "string" ? theme.name.trim().slice(0, 60) : "",
    colors: Array.isArray(theme.colors)
      ? theme.colors.slice(0, 5).map(String)
      : [],
    vibe: typeof theme.vibe === "string" ? theme.vibe.trim().slice(0, 100) : "",
  };
};

const validateUpdateSettings = (req) => {
  const body = req.body || {};
  const value = {};
  const details = [];

  if (body.activeTheme !== undefined) {
    const t = normalizeTheme(body.activeTheme);
    if (!t || !t.colors.length) {
      details.push({ field: "activeTheme", message: "Must include at least one color" });
    } else {
      value.activeTheme = t;
    }
  }

  if (body.defaultSize !== undefined) {
    if (!VALID_SIZES.includes(body.defaultSize)) {
      details.push({ field: "defaultSize", message: `Must be one of: ${VALID_SIZES.join(", ")}` });
    } else {
      value.defaultSize = body.defaultSize;
    }
  }

  if (body.defaultQuality !== undefined) {
    if (!VALID_QUALITIES.includes(body.defaultQuality)) {
      details.push({ field: "defaultQuality", message: `Must be one of: ${VALID_QUALITIES.join(", ")}` });
    } else {
      value.defaultQuality = body.defaultQuality;
    }
  }

  if (body.defaultLanguage !== undefined) {
    if (!VALID_LANGUAGES.includes(body.defaultLanguage)) {
      details.push({ field: "defaultLanguage", message: `Must be one of: ${VALID_LANGUAGES.join(", ")}` });
    } else {
      value.defaultLanguage = body.defaultLanguage;
    }
  }

  if (body.defaultStyle !== undefined) {
    if (!VALID_STYLES.includes(body.defaultStyle)) {
      details.push({ field: "defaultStyle", message: `Must be one of: ${VALID_STYLES.join(", ")}` });
    } else {
      value.defaultStyle = body.defaultStyle;
    }
  }

  if (body.useModelImage !== undefined) {
    value.useModelImage = Boolean(body.useModelImage);
  }

  if (details.length) {
    return { error: "Validation failed.", details };
  }

  return { value };
};

const validateEditDay = (req) => {
  const body = req.body || {};
  const value = {};

  if (body.topic !== undefined) value.topic = trimStr(body.topic).slice(0, 100);
  if (body.description !== undefined) value.description = trimStr(body.description).slice(0, 300);

  if (!Object.keys(value).length) {
    return { error: "Nothing to update. Provide topic or description." };
  }
  return { value };
};

const validateEditDayPrompt = (req) => {
  const body = req.body || {};
  const value = {};

  if (body.headline !== undefined) value.headline = trimStr(body.headline).slice(0, 200);
  if (body.tagline !== undefined) value.tagline = trimStr(body.tagline).slice(0, 200);
  if (body.offer !== undefined) value.offer = trimStr(body.offer).slice(0, 500);
  if (body.cta !== undefined) value.cta = trimStr(body.cta).slice(0, 100);
  if (body.fullPrompt !== undefined) value.fullPrompt = trimStr(body.fullPrompt).slice(0, 5000);

  if (!Object.keys(value).length) {
    return { error: "Nothing to update. Provide headline, tagline, offer, cta, or fullPrompt." };
  }
  return { value };
};

module.exports = {
  validateUpdateSettings,
  validateEditDay,
  validateEditDayPrompt,
  VALID_SIZES,
  VALID_QUALITIES,
  VALID_LANGUAGES,
  VALID_STYLES,
};
