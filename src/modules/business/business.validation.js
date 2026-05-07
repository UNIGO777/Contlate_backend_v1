const { isNonEmptyString } = require("../../validators/common.validator");

const trimOrUndef = (v) => (typeof v === "string" ? v.trim() : v);

const isValidHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim());

const isValidTimezone = (tz) => {
  if (!isNonEmptyString(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const normalizeTheme = (theme) => {
  if (!theme || typeof theme !== "object") return undefined;
  return {
    name:   typeof theme.name === "string" ? theme.name.trim() : "",
    colors: Array.isArray(theme.colors) ? theme.colors.slice(0, 3).map(String) : [],
    vibe:   typeof theme.vibe === "string" ? theme.vibe.trim() : "",
  };
};

const normalizeCreatePayload = (body = {}) => ({
  businessName:  trimOrUndef(body.businessName),
  category:      trimOrUndef(body.category),
  subcategories: Array.isArray(body.subcategories)
    ? body.subcategories.slice(0, 10).map((s) => String(s).trim()).filter(Boolean)
    : [],
  services: Array.isArray(body.services)
    ? body.services.slice(0, 12).map((s) => String(s).trim()).filter(Boolean)
    : [],
  description:   typeof body.description === "string" ? body.description.trim().slice(0, 1500) : "",
  phone:         trimOrUndef(body.phone),
  address:       trimOrUndef(body.address),
  timezone:      trimOrUndef(body.timezone),
  brandAssets: {
    logoUrl:       body.brandAssets?.logoUrl?.trim() || "",
    primaryColor:  body.brandAssets?.primaryColor?.trim() || "",
    secondaryColor: body.brandAssets?.secondaryColor?.trim() || "",
    theme:         normalizeTheme(body.brandAssets?.theme) || { name: "", colors: [], vibe: "" },
  },
  google: body.google?.placeId
    ? { placeId: String(body.google.placeId).trim() }
    : undefined,
});

const normalizeAddressDetails = (addressDetails = {}) => ({
  line1:    trimOrUndef(addressDetails.line1) || "",
  line2:    trimOrUndef(addressDetails.line2) || "",
  landmark: trimOrUndef(addressDetails.landmark) || "",
  city:     trimOrUndef(addressDetails.city) || "",
  state:    trimOrUndef(addressDetails.state) || "",
  country:  trimOrUndef(addressDetails.country) || "",
  pincode:  trimOrUndef(addressDetails.pincode) || "",
});

const validateSetupStart = (req) => {
  const body = req.body || {};
  const value = {
    businessName: trimOrUndef(body.businessName),
    phone: trimOrUndef(body.phone),
  };
  const details = [];
  if (!isNonEmptyString(value.businessName)) details.push("businessName is required.");
  if (!isNonEmptyString(value.phone)) details.push("phone is required.");
  return details.length ? { error: "Validation failed.", details } : { value };
};

const validateSetupAddress = (req) => {
  const body = req.body || {};
  const addressDetails = normalizeAddressDetails(body.addressDetails);
  const details = [];

  for (const f of ["line1", "city", "state", "country", "pincode"]) {
    if (!isNonEmptyString(addressDetails[f])) details.push(`addressDetails.${f} is required.`);
  }

  const timezone = trimOrUndef(body.timezone);
  if (!isNonEmptyString(timezone)) {
    details.push("timezone is required.");
  } else if (!isValidTimezone(timezone)) {
    details.push("timezone is not a valid IANA timezone.");
  }

  return details.length
    ? { error: "Validation failed.", details }
    : { value: { addressDetails, timezone } };
};

const validateSetupPlacesMatch = (req) => {
  const body = req.body || {};
  const value = {
    businessName: trimOrUndef(body.businessName),
    phone: trimOrUndef(body.phone),
    pincode: trimOrUndef(body.pincode),
    city: trimOrUndef(body.city) || "",
    state: trimOrUndef(body.state) || "",
    address: trimOrUndef(body.address) || "",
  };
  const details = [];
  if (!isNonEmptyString(value.businessName)) details.push("businessName is required.");
  if (!isNonEmptyString(value.phone)) details.push("phone is required.");
  if (!isNonEmptyString(value.pincode)) details.push("pincode is required.");
  return details.length ? { error: "Validation failed.", details } : { value };
};

const validateSetupPlaceSelect = (req) => {
  const placeId = trimOrUndef(req.body?.placeId);
  if (!isNonEmptyString(placeId)) {
    return { error: "Validation failed.", details: ["placeId is required."] };
  }
  return { value: { placeId } };
};

const validateSetupComplete = (req) => {
  const body = req.body || {};
  const value = {};
  const details = [];

  if (!isNonEmptyString(body.category)) {
    details.push("category is required.");
  } else {
    value.category = body.category.trim();
  }

  value.subcategories = Array.isArray(body.subcategories)
    ? body.subcategories.slice(0, 10).map((s) => String(s).trim()).filter(Boolean)
    : [];

  value.services = Array.isArray(body.services)
    ? body.services.slice(0, 12).map((s) => String(s).trim()).filter(Boolean)
    : [];

  value.description = typeof body.description === "string"
    ? body.description.trim().slice(0, 1500)
    : "";

  if (body.brandAssets !== undefined) {
    if (typeof body.brandAssets !== "object" || body.brandAssets === null) {
      details.push("brandAssets must be an object.");
    } else {
      value.brandAssets = {};
      for (const f of ["logoUrl", "primaryColor", "secondaryColor"]) {
        if (body.brandAssets[f] !== undefined) {
          if (typeof body.brandAssets[f] !== "string") details.push(`brandAssets.${f} must be a string.`);
          else value.brandAssets[f] = body.brandAssets[f].trim();
        }
      }
      if (body.brandAssets.theme !== undefined) {
        const t = normalizeTheme(body.brandAssets.theme);
        if (t && t.colors.length > 0 && t.colors.length !== 3) {
          details.push("brandAssets.theme.colors must contain exactly 3 hex values.");
        } else if (t && t.colors.length === 3 && !t.colors.every(isValidHex)) {
          details.push("brandAssets.theme.colors must all be valid hex colour strings.");
        } else {
          value.brandAssets.theme = t;
        }
      }
    }
  }

  return details.length ? { error: "Validation failed.", details } : { value };
};

const validateCreateBusiness = (req) => {
  const payload = normalizeCreatePayload(req.body);
  const details = [];

  for (const f of ["businessName", "category", "phone", "address"]) {
    if (!isNonEmptyString(payload[f])) details.push(`${f} is required.`);
  }

  if (!isNonEmptyString(payload.timezone)) {
    details.push("timezone is required.");
  } else if (!isValidTimezone(payload.timezone)) {
    details.push("timezone is not a valid IANA timezone.");
  }

  if (payload.brandAssets?.theme?.colors?.length > 0) {
    if (payload.brandAssets.theme.colors.length !== 3) {
      details.push("brandAssets.theme.colors must contain exactly 3 hex values.");
    } else if (!payload.brandAssets.theme.colors.every(isValidHex)) {
      details.push("brandAssets.theme.colors must all be valid hex colour strings.");
    }
  }

  return details.length ? { error: "Validation failed.", details } : { value: payload };
};

const validateUpdateBusiness = (req) => {
  const body = req.body || {};
  const value = {};
  const details = [];

  for (const f of ["businessName", "category", "phone", "address"]) {
    if (body[f] !== undefined) {
      if (!isNonEmptyString(body[f])) details.push(`${f} must be a non-empty string.`);
      else value[f] = body[f].trim();
    }
  }

  if (body.timezone !== undefined) {
    if (!isNonEmptyString(body.timezone) || !isValidTimezone(body.timezone)) {
      details.push("timezone is not a valid IANA timezone.");
    } else {
      value.timezone = body.timezone.trim();
    }
  }

  if (body.subcategories !== undefined) {
    if (!Array.isArray(body.subcategories)) {
      details.push("subcategories must be an array.");
    } else {
      value.subcategories = body.subcategories
        .slice(0, 10)
        .map((s) => String(s).trim())
        .filter(Boolean);
    }
  }

  if (body.services !== undefined) {
    if (!Array.isArray(body.services)) {
      details.push("services must be an array.");
    } else {
      value.services = body.services
        .slice(0, 12)
        .map((s) => String(s).trim())
        .filter(Boolean);
    }
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      details.push("description must be a string.");
    } else {
      value.description = body.description.trim().slice(0, 1500);
    }
  }

  if (body.brandAssets !== undefined) {
    if (typeof body.brandAssets !== "object" || body.brandAssets === null) {
      details.push("brandAssets must be an object.");
    } else {
      value.brandAssets = {};
      for (const f of ["logoUrl", "primaryColor", "secondaryColor"]) {
        if (body.brandAssets[f] !== undefined) {
          if (typeof body.brandAssets[f] !== "string") details.push(`brandAssets.${f} must be a string.`);
          else value.brandAssets[f] = body.brandAssets[f].trim();
        }
      }
      if (body.brandAssets.theme !== undefined) {
        const t = normalizeTheme(body.brandAssets.theme);
        if (t && t.colors.length > 0 && t.colors.length !== 3) {
          details.push("brandAssets.theme.colors must contain exactly 3 hex values.");
        } else if (t && t.colors.length === 3 && !t.colors.every(isValidHex)) {
          details.push("brandAssets.theme.colors must all be valid hex colour strings.");
        } else {
          value.brandAssets.theme = t;
        }
      }
    }
  }

  if (body.autopilot !== undefined) {
    if (typeof body.autopilot !== "object" || body.autopilot === null) {
      details.push("autopilot must be an object.");
    } else {
      value.autopilot = {};
      if (body.autopilot.enabled !== undefined)
        value.autopilot.enabled = Boolean(body.autopilot.enabled);
      if (body.autopilot.approvalRequired !== undefined)
        value.autopilot.approvalRequired = Boolean(body.autopilot.approvalRequired);
    }
  }

  if (Object.keys(value).length === 0 && details.length === 0) {
    details.push("At least one field is required.");
  }

  return details.length ? { error: "Validation failed.", details } : { value };
};

const validateBrandAssets = (req) => {
  const ba = req.body || {};
  const details = [];
  const value = {};

  for (const f of ["logoUrl", "primaryColor", "secondaryColor"]) {
    if (ba[f] !== undefined) {
      if (typeof ba[f] !== "string") details.push(`${f} must be a string.`);
      else value[f] = ba[f].trim();
    }
  }

  if (ba.theme !== undefined) {
    const t = normalizeTheme(ba.theme);
    if (t && t.colors.length > 0 && t.colors.length !== 3) {
      details.push("theme.colors must contain exactly 3 hex values.");
    } else if (t && t.colors.length === 3 && !t.colors.every(isValidHex)) {
      details.push("theme.colors must all be valid hex colour strings.");
    } else {
      value.theme = t;
    }
  }

  if (Object.keys(value).length === 0 && details.length === 0) {
    details.push("At least one brand asset field is required.");
  }
  return details.length ? { error: "Validation failed.", details } : { value };
};

const validateGenerateDescription = (req) => {
  const b = req.body || {};
  const str = (v, label) => {
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new Error(`${label} must be a string.`);
    return v.trim();
  };
  try {
    return {
      value: {
        placeId:       str(b.placeId, "placeId"),
        description:   str(b.description, "description"),
        businessName:  str(b.businessName, "businessName"),
        category:      str(b.category, "category"),
        subcategories: Array.isArray(b.subcategories)
          ? b.subcategories.slice(0, 10).map((s) => String(s).trim()).filter(Boolean)
          : undefined,
        services: Array.isArray(b.services)
          ? b.services.slice(0, 12).map((s) => String(s).trim()).filter(Boolean)
          : undefined,
        city:    str(b.city, "city"),
        country: str(b.country, "country"),
        address: str(b.address, "address"),
        phone:   str(b.phone, "phone"),
      },
    };
  } catch (e) {
    return { error: "Validation failed.", details: [e.message] };
  }
};

module.exports = {
  validateCreateBusiness,
  validateUpdateBusiness,
  validateBrandAssets,
  validateGenerateDescription,
  validateSetupStart,
  validateSetupAddress,
  validateSetupPlacesMatch,
  validateSetupPlaceSelect,
  validateSetupComplete,
  // Backward compat alias
  validateBusinessPayload: validateCreateBusiness,
};
