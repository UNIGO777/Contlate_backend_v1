const ApiError = require("../../core/ApiError");
const logger = require("../../core/logger");
const { ERROR_CODES } = require("../../constants/errorCodes");
const placesService = require("../../services/places.service");
const openaiService = require("../../services/openai.service");
const Business = require("./business.model");

const REQUIRED_FIELDS = ["businessName", "category", "phone", "address", "timezone"];

const deriveIsCompleted = (business) =>
  REQUIRED_FIELDS.every((f) => typeof business[f] === "string" && business[f].trim().length > 0);

const sanitizeBusiness = (business) => ({
  id: business._id.toString(),
  userId: business.userId.toString(),
  businessName: business.businessName,
  category: business.category,
  subcategories: business.subcategories || [],
  description: business.description || "",
  phone: business.phone,
  address: business.address,
  brandAssets: {
    logoUrl:       business.brandAssets?.logoUrl || "",
    primaryColor:  business.brandAssets?.primaryColor || "",
    secondaryColor: business.brandAssets?.secondaryColor || "",
    theme: {
      name:   business.brandAssets?.theme?.name || "",
      colors: business.brandAssets?.theme?.colors || [],
      vibe:   business.brandAssets?.theme?.vibe || "",
    },
  },
  timezone: business.timezone,
  isCompleted: deriveIsCompleted(business),
  autopilot: {
    enabled:          business.autopilot?.enabled ?? true,
    approvalRequired: business.autopilot?.approvalRequired ?? false,
  },
  google: business.google
    ? {
        placeId:                  business.google.placeId || "",
        formattedAddress:         business.google.formattedAddress || "",
        website:                  business.google.website || "",
        internationalPhoneNumber: business.google.internationalPhoneNumber || "",
        rating:                   business.google.rating,
        userRatingCount:          business.google.userRatingCount,
        googleMapsUri:            business.google.googleMapsUri || "",
        businessStatus:           business.google.businessStatus || "",
        types:                    business.google.types || [],
        regularOpeningHours:      business.google.regularOpeningHours || null,
        location:                 business.google.location || { lat: null, lng: null },
        fetchedAt:                business.google.fetchedAt,
      }
    : null,
  createdAt: business.createdAt,
  updatedAt: business.updatedAt,
});

// Enriches a Business document in-place with data from Google Places.
// Only backfills user-facing fields when the user left them blank.
// Never throws — Google outages must not block business setup.
const enrichWithGooglePlaces = async (business, { placeId } = {}) => {
  if (!placesService.isConfigured()) return business;
  try {
    const place = await placesService.findBusiness({
      businessName: business.businessName,
      address: business.address,
      placeId: placeId || business.google?.placeId,
    });
    if (!place) {
      business.google = {
        ...(business.google?.toObject?.() || business.google || {}),
        lastError: "No matching place found.",
        fetchedAt: new Date(),
      };
      await business.save();
      return business;
    }
    business.google = {
      placeId:                  place.placeId,
      formattedAddress:         place.formattedAddress,
      website:                  place.website,
      internationalPhoneNumber: place.internationalPhoneNumber,
      rating:                   place.rating,
      userRatingCount:          place.userRatingCount,
      googleMapsUri:            place.googleMapsUri,
      businessStatus:           place.businessStatus,
      types:                    place.types,
      regularOpeningHours:      place.regularOpeningHours,
      location:                 place.location,
      fetchedAt:                new Date(),
      lastError:                "",
    };
    if ((!business.phone || !business.phone.trim()) && place.internationalPhoneNumber) {
      business.phone = place.internationalPhoneNumber;
    }
    if ((!business.address || !business.address.trim()) && place.formattedAddress) {
      business.address = place.formattedAddress;
    }
    await business.save();
  } catch (err) {
    logger.warn("[business] places enrichment failed", { message: err.message });
    try {
      business.google = {
        ...(business.google?.toObject?.() || business.google || {}),
        lastError: err.message?.slice(0, 500) || "Places lookup failed.",
        fetchedAt: new Date(),
      };
      await business.save();
    } catch {
      /* ignore secondary failure */
    }
  }
  return business;
};

const createBusiness = async (userId, payload) => {
  const existing = await Business.findOne({ userId });
  if (existing) {
    throw new ApiError(409, "Business profile already exists for this user.", {
      code: ERROR_CODES.BUSINESS_ALREADY_EXISTS,
    });
  }
  const placeId = payload.google?.placeId;
  const { google: _g, ...rest } = payload;
  const business = await Business.create({ userId, ...rest });
  business.isCompleted = deriveIsCompleted(business);
  await business.save();
  await enrichWithGooglePlaces(business, { placeId });
  return sanitizeBusiness(business);
};

const getBusinessByUserId = async (userId) => {
  const business = await Business.findOne({ userId });
  if (!business) {
    throw new ApiError(404, "Business profile not found.", {
      code: ERROR_CODES.BUSINESS_NOT_FOUND,
    });
  }
  return sanitizeBusiness(business);
};

const updateBusiness = async (userId, payload) => {
  const business = await Business.findOne({ userId });
  if (!business) {
    throw new ApiError(404, "Business profile not found.", {
      code: ERROR_CODES.BUSINESS_NOT_FOUND,
    });
  }
  const nameOrAddressChanged =
    (payload.businessName !== undefined && payload.businessName !== business.businessName) ||
    (payload.address !== undefined && payload.address !== business.address);

  for (const f of [...REQUIRED_FIELDS, "subcategories", "description"]) {
    if (payload[f] !== undefined) business[f] = payload[f];
  }
  if (payload.brandAssets) {
    business.brandAssets = {
      logoUrl:       payload.brandAssets.logoUrl       ?? business.brandAssets?.logoUrl       ?? "",
      primaryColor:  payload.brandAssets.primaryColor  ?? business.brandAssets?.primaryColor  ?? "",
      secondaryColor: payload.brandAssets.secondaryColor ?? business.brandAssets?.secondaryColor ?? "",
      theme: payload.brandAssets.theme
        ? {
            name:   payload.brandAssets.theme.name   ?? business.brandAssets?.theme?.name   ?? "",
            colors: payload.brandAssets.theme.colors ?? business.brandAssets?.theme?.colors ?? [],
            vibe:   payload.brandAssets.theme.vibe   ?? business.brandAssets?.theme?.vibe   ?? "",
          }
        : business.brandAssets?.theme ?? { name: "", colors: [], vibe: "" },
    };
  }
  if (payload.autopilot) {
    business.autopilot = {
      enabled:          payload.autopilot.enabled          ?? business.autopilot?.enabled          ?? true,
      approvalRequired: payload.autopilot.approvalRequired ?? business.autopilot?.approvalRequired ?? false,
    };
  }
  business.isCompleted = deriveIsCompleted(business);
  await business.save();
  if (nameOrAddressChanged) {
    await enrichWithGooglePlaces(business);
  }
  return sanitizeBusiness(business);
};

const refreshGoogle = async (userId, { placeId } = {}) => {
  const business = await Business.findOne({ userId });
  if (!business) {
    throw new ApiError(404, "Business profile not found.", {
      code: ERROR_CODES.BUSINESS_NOT_FOUND,
    });
  }
  if (!placesService.isConfigured()) {
    throw new ApiError(501, "Google Places is not configured on this server.");
  }
  await enrichWithGooglePlaces(business, { placeId });
  return sanitizeBusiness(business);
};

const updateBrandAssets = async (userId, brandAssets) => {
  const business = await Business.findOne({ userId });
  if (!business) {
    throw new ApiError(404, "Business profile not found.", {
      code: ERROR_CODES.BUSINESS_NOT_FOUND,
    });
  }
  business.brandAssets = {
    logoUrl:       brandAssets.logoUrl       ?? business.brandAssets?.logoUrl       ?? "",
    primaryColor:  brandAssets.primaryColor  ?? business.brandAssets?.primaryColor  ?? "",
    secondaryColor: brandAssets.secondaryColor ?? business.brandAssets?.secondaryColor ?? "",
    theme: brandAssets.theme
      ? {
          name:   brandAssets.theme.name   ?? business.brandAssets?.theme?.name   ?? "",
          colors: brandAssets.theme.colors ?? business.brandAssets?.theme?.colors ?? [],
          vibe:   brandAssets.theme.vibe   ?? business.brandAssets?.theme?.vibe   ?? "",
        }
      : business.brandAssets?.theme ?? { name: "", colors: [], vibe: "" },
  };
  await business.save();
  return sanitizeBusiness(business);
};

// Server-side Places search proxy — used by the onboarding Google Places step.
// Returns up to 5 lightweight results without leaking the API key to the browser.
const searchPlaces = async (query) => {
  if (!query || !query.trim()) {
    throw new ApiError(400, "Search query is required.", {
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  }
  if (!placesService.isConfigured()) {
    throw new ApiError(501, "Google Places is not configured on this server.");
  }
  const results = await placesService.searchMultiple(query.trim(), 5);
  return results.map((p) => ({
    placeId:          p.placeId,
    name:             p.displayName || "",
    formattedAddress: p.formattedAddress,
    rating:           p.rating,
    userRatingCount:  p.userRatingCount,
    phone:            p.internationalPhoneNumber,
    website:          p.website,
  }));
};

// Generates a brand description for the onboarding AI brand story step.
// Generates a brand story from onboarding input.
// Order of preference:
//   1. OpenAI (when OPENAI_API_KEY is set) — uses everything we know.
//   2. Template built from a Google Place (when placeId resolves).
//   3. The user's raw description, returned as-is.
//   4. A safe generic fallback.
const generateDescription = async (input = {}) => {
  const { placeId, description, businessName, category, subcategories, city, country, address, phone } = input;

  // 1. Resolve a Google Place if we have a placeId — also feeds the LLM.
  let googlePlace = null;
  if (placeId && placesService.isConfigured()) {
    try {
      googlePlace = await placesService.findBusiness({ placeId });
    } catch (err) {
      logger.warn("[business] generateDescription places lookup failed", { message: err.message });
    }
  }

  // 2. Try OpenAI when configured.
  if (openaiService.isConfigured()) {
    try {
      const text = await openaiService.generateBrandStory({
        businessName, category, subcategories, city, country, address, phone,
        description,
        googlePlace,
      });
      return { description: text, source: "openai" };
    } catch (err) {
      logger.warn("[business] OpenAI brand story failed; falling back", { message: err.message });
    }
  }

  // 3. Template from Google Place if we got one.
  if (googlePlace) {
    const type = googlePlace.types?.[0]?.replace(/_/g, " ") || "business";
    const hours = googlePlace.regularOpeningHours?.weekdayDescriptions?.[0] || "";
    const website = googlePlace.website ? ` Visit us at ${googlePlace.website}.` : "";
    const phoneLine = googlePlace.internationalPhoneNumber
      ? ` Reach us at ${googlePlace.internationalPhoneNumber}.`
      : "";
    return {
      description:
        `${googlePlace.displayName || businessName || "Our business"} is a trusted ${type} ` +
        `located at ${googlePlace.formattedAddress}.` +
        (hours ? ` ${hours}.` : "") +
        website +
        phoneLine,
      source: "places-template",
    };
  }

  // 4. Echo the user's own words.
  if (description && description.trim().length >= 6) {
    return { description: description.trim(), source: "user" };
  }

  // 5. Last-resort generic copy.
  return {
    description:
      "We are a passionate business dedicated to delivering quality products and " +
      "exceptional service to our community. Our team works hard every day to " +
      "ensure the best experience for every customer.",
    source: "fallback",
  };
};

const findBusinessDocumentByUserId = async (userId) => Business.findOne({ userId });

module.exports = {
  createBusiness,
  getBusinessByUserId,
  updateBusiness,
  updateBrandAssets,
  refreshGoogle,
  searchPlaces,
  generateDescription,
  findBusinessDocumentByUserId,
};
