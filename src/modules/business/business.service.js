const ApiError = require("../../core/ApiError");
const logger = require("../../core/logger");
const { ERROR_CODES } = require("../../constants/errorCodes");
const placesService = require("../../services/places.service");
const openaiService = require("../../services/openai.service");
const cloudinaryService = require("../../services/cloudinary.service");
const Business = require("./business.model");

const REQUIRED_FIELDS = ["businessName", "category", "phone", "address", "timezone"];

const deriveIsCompleted = (business) =>
  REQUIRED_FIELDS.every((f) => typeof business[f] === "string" && business[f].trim().length > 0);

// Derives the furthest onboarding step from field presence.
// Used for old records where onboardingStep was not yet tracked.
// Returns 0–6; 7 is only set explicitly by completeSetup.
const deriveOnboardingStep = (business) => {
  if (!business.businessName?.trim() || !business.phone?.trim()) return 0;
  if (!business.address?.trim() || !business.timezone?.trim()) return 1;
  if (!business.category?.trim()) return 3; // skip Google match (step 2) — safe to retry
  if (!business.description?.trim()) return 4;
  const hasBrand = !!(business.brandAssets?.theme?.name?.trim() || business.brandAssets?.logoUrl?.trim());
  if (!hasBrand) return 5;
  return 6;
};

const formatAddress = (addressDetails = {}) =>
  [
    addressDetails.line1,
    addressDetails.line2,
    addressDetails.landmark,
    addressDetails.city,
    addressDetails.state,
    addressDetails.country,
  ]
    .filter((part) => typeof part === "string" && part.trim())
    .map((part) => part.trim())
    .join(", ") +
  (addressDetails.pincode ? ` - ${addressDetails.pincode}` : "");

const digitsOnly = (value = "") => String(value).replace(/\D/g, "");

const phoneMatches = (a, b) => {
  const left = digitsOnly(a);
  const right = digitsOnly(b);
  if (!left || !right) return false;
  return left.endsWith(right.slice(-10)) || right.endsWith(left.slice(-10));
};

const humanizePlaceType = (type = "") =>
  String(type)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();

const categoryFromGoogleTypes = (types = [], primaryType = "") => {
  const set = new Set([primaryType, ...types].filter(Boolean));
  const has = (...items) => items.some((item) => set.has(item));

  if (has("restaurant", "meal_takeaway", "meal_delivery", "indian_restaurant", "fast_food_restaurant")) {
    return "Restaurant";
  }
  if (has("cafe", "coffee_shop", "bakery")) return "Cafe";
  if (has("beauty_salon", "hair_care", "spa", "nail_salon")) return "Salon";
  if (has("gym", "fitness_center", "yoga_studio")) return "Gym";
  if (has("doctor", "dentist", "hospital", "physiotherapist", "pharmacy", "medical_lab", "clinic")) {
    return "Clinic";
  }
  if (has("store", "clothing_store", "shoe_store", "jewelry_store", "electronics_store", "furniture_store", "home_goods_store", "supermarket", "grocery_store", "convenience_store")) {
    return "Retail Store";
  }
  if (has("school", "university", "preschool", "primary_school", "secondary_school")) {
    return "Coaching";
  }
  if (has("real_estate_agency")) return "Real Estate";
  if (has("lawyer", "accounting", "insurance_agency", "travel_agency", "consultant")) {
    return "Professional Services";
  }

  return humanizePlaceType(primaryType || types[0] || "");
};

const servicesFromGoogleTypes = (types = [], primaryType = "") => {
  const set = new Set([primaryType, ...types].filter(Boolean));
  const has = (...items) => items.some((item) => set.has(item));
  const services = [];

  if (has("restaurant", "meal_takeaway", "meal_delivery", "indian_restaurant", "fast_food_restaurant")) {
    services.push("Dine-in", "Takeaway", "Home Delivery");
  }
  if (has("cafe", "coffee_shop")) services.push("Coffee Service", "Snacks", "Takeaway");
  if (has("bakery")) services.push("Fresh Bakery", "Custom Cakes", "Takeaway");
  if (has("beauty_salon", "hair_care")) services.push("Haircut", "Hair Styling", "Hair Color");
  if (has("spa")) services.push("Massage", "Facial", "Body Spa");
  if (has("nail_salon")) services.push("Manicure", "Pedicure", "Nail Art");
  if (has("gym", "fitness_center")) services.push("Personal Training", "Group Classes", "Fitness Plans");
  if (has("yoga_studio")) services.push("Yoga Sessions", "Meditation", "Group Classes");
  if (has("doctor", "clinic", "hospital")) services.push("Consultation", "Follow-up Visit", "Health Checkup");
  if (has("dentist")) services.push("Dental Consultation", "Cleaning", "Dental Treatment");
  if (has("medical_lab")) services.push("Lab Tests", "Sample Collection", "Reports");
  if (has("pharmacy")) services.push("Medicines", "Prescription Support", "Health Products");
  if (has("store", "clothing_store", "shoe_store", "jewelry_store", "electronics_store", "furniture_store", "home_goods_store", "supermarket", "grocery_store", "convenience_store")) {
    services.push("In-store Shopping", "Product Consultation", "Home Delivery");
  }
  if (has("school", "university", "preschool", "primary_school", "secondary_school")) {
    services.push("Admissions", "Classes", "Student Support");
  }
  if (has("real_estate_agency")) services.push("Property Consultation", "Site Visit", "Documentation");
  if (has("lawyer")) services.push("Legal Consultation", "Documentation", "Case Support");
  if (has("accounting")) services.push("Accounting", "Tax Filing", "Bookkeeping");
  if (has("travel_agency")) services.push("Trip Planning", "Ticket Booking", "Travel Packages");

  return services.filter((value, index, arr) => arr.indexOf(value) === index).slice(0, 12);
};

const profileSuggestionsFromGoogle = (business) => {
  const google = business.google || {};
  const types = Array.isArray(google.types) ? google.types : [];
  const ignored = new Set([
    "point_of_interest",
    "establishment",
    "food",
    "store",
    "health",
    "general_contractor",
  ]);
  const subcategories = [
    google.primaryTypeDisplayName,
    ...types.filter((type) => !ignored.has(type)).map(humanizePlaceType),
  ]
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 10);

  const category = categoryFromGoogleTypes(types, google.primaryType);
  const services = servicesFromGoogleTypes(types, google.primaryType);
  const typeLabel = category || subcategories[0] || "business";
  const hours = google.regularOpeningHours?.weekdayDescriptions?.[0] || "";
  const website = google.website ? ` Visit us at ${google.website}.` : "";
  const phoneLine = google.internationalPhoneNumber
    ? ` Reach us at ${google.internationalPhoneNumber}.`
    : "";
  const description =
    google.editorialSummary ||
    `${business.businessName || "Our business"} is a trusted ${typeLabel.toLowerCase()} located at ${google.formattedAddress || business.address}.` +
      (hours ? ` ${hours}.` : "") +
      website +
      phoneLine;

  return {
    category,
    subcategories,
    services,
    description: description.trim().slice(0, 1500),
    source: google.editorialSummary ? "google-editorial-summary" : "google-place-template",
  };
};

const googlePlaceForAi = (business) => {
  const google = business.google || {};
  return {
    displayName: google.displayName || business.businessName || "",
    formattedAddress: google.formattedAddress || business.address || "",
    website: google.website || "",
    internationalPhoneNumber: google.internationalPhoneNumber || business.phone || "",
    rating: google.rating,
    userRatingCount: google.userRatingCount,
    googleMapsUri: google.googleMapsUri || "",
    businessStatus: google.businessStatus || "",
    types: google.types || [],
    primaryType: google.primaryType || "",
    primaryTypeDisplayName: google.primaryTypeDisplayName || "",
    editorialSummary: google.editorialSummary || "",
    regularOpeningHours: google.regularOpeningHours || null,
    location: google.location || { lat: null, lng: null },
  };
};

const profileSuggestionsForBusiness = async (business) => {
  const fallback = profileSuggestionsFromGoogle(business);
  if (!openaiService.isConfigured()) {
    return { ...fallback, aiStatus: "not_configured" };
  }

  try {
    logger.info("[business] generating profile suggestions with OpenAI", {
      businessId: business._id?.toString(),
      placeId: business.google?.placeId || "",
    });
    const ai = await openaiService.generateBusinessProfileSuggestions({
      businessName: business.businessName,
      phone: business.phone,
      address: business.address,
      addressDetails: business.addressDetails,
      category: business.category,
      subcategories: business.subcategories || [],
      services: business.services || [],
      description: business.description || "",
      googlePlace: googlePlaceForAi(business),
    });

    return {
      category: ai.category || fallback.category,
      subcategories: ai.subcategories?.length ? ai.subcategories : fallback.subcategories,
      services: ai.services?.length ? ai.services : fallback.services,
      description: ai.description || fallback.description,
      source: "openai",
      aiStatus: "generated",
    };
  } catch (err) {
    logger.warn("[business] OpenAI profile suggestions failed; falling back", {
      message: err.message,
    });
    return {
      ...fallback,
      aiStatus: "fallback",
      aiError: err.message?.slice(0, 180) || "OpenAI generation failed.",
    };
  }
};

const sanitizeBusiness = (business) => {
  // For records that predate onboardingStep tracking, derive the furthest step
  // from field presence. For records where completeSetup was called, storedStep = 7.
  const storedStep = business.onboardingStep ?? 0;
  const onboardingStep = storedStep > 0 ? storedStep : deriveOnboardingStep(business);

  return {
  id: business._id.toString(),
  userId: business.userId.toString(),
  businessName: business.businessName,
  contactEmail: business.contactEmail || "",
  hasContactEmail: business.hasContactEmail ?? false,
  category: business.category,
  subcategories: business.subcategories || [],
  services: business.services || [],
  description: business.description || "",
  website: business.website || "",
  phone: business.phone,
  address: business.address,
  addressDetails: {
    line1:    business.addressDetails?.line1 || "",
    line2:    business.addressDetails?.line2 || "",
    landmark: business.addressDetails?.landmark || "",
    city:     business.addressDetails?.city || "",
    state:    business.addressDetails?.state || "",
    country:  business.addressDetails?.country || "",
    pincode:  business.addressDetails?.pincode || "",
  },
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
  savedThemes: (business.savedThemes || []).map((t) => ({
    name:   t.name || "",
    colors: t.colors || [],
    vibe:   t.vibe || "",
  })),
  timezone: business.timezone,
  onboardingStep,
  isCompleted: onboardingStep >= 7,
  autopilot: {
    enabled:          business.autopilot?.enabled ?? true,
    approvalRequired: business.autopilot?.approvalRequired ?? false,
  },
  google: business.google
    ? {
        placeId:                  business.google.placeId || "",
        displayName:              business.google.displayName || "",
        formattedAddress:         business.google.formattedAddress || "",
        website:                  business.google.website || "",
        internationalPhoneNumber: business.google.internationalPhoneNumber || "",
        rating:                   business.google.rating,
        userRatingCount:          business.google.userRatingCount,
        googleMapsUri:            business.google.googleMapsUri || "",
        businessStatus:           business.google.businessStatus || "",
        types:                    business.google.types || [],
        primaryType:               business.google.primaryType || "",
        primaryTypeDisplayName:    business.google.primaryTypeDisplayName || "",
        editorialSummary:          business.google.editorialSummary || "",
        regularOpeningHours:      business.google.regularOpeningHours || null,
        location:                 business.google.location || { lat: null, lng: null },
        fetchedAt:                business.google.fetchedAt,
      }
    : null,
  createdAt: business.createdAt,
  updatedAt: business.updatedAt,
  };
};

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
      displayName:               place.displayName,
      formattedAddress:         place.formattedAddress,
      website:                  place.website,
      internationalPhoneNumber: place.internationalPhoneNumber,
      rating:                   place.rating,
      userRatingCount:          place.userRatingCount,
      googleMapsUri:            place.googleMapsUri,
      businessStatus:           place.businessStatus,
      types:                    place.types,
      primaryType:               place.primaryType,
      primaryTypeDisplayName:    place.primaryTypeDisplayName,
      editorialSummary:          place.editorialSummary,
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

const startSetup = async (userId, { businessName, phone, contactEmail, hasContactEmail }) => {
  let business = await Business.findOne({ userId });
  if (!business) {
    business = await Business.create({
      userId,
      businessName,
      phone,
      contactEmail: hasContactEmail ? (contactEmail || "") : "",
      hasContactEmail: !!hasContactEmail,
      category: "",
      address: "",
      timezone: "",
      isCompleted: false,
      onboardingStep: 1,
    });
  } else {
    business.businessName = businessName;
    business.phone = phone;
    business.hasContactEmail = !!hasContactEmail;
    business.contactEmail = hasContactEmail ? (contactEmail || "") : "";
    business.onboardingStep = Math.max(business.onboardingStep || 0, 1);
    await business.save();
  }
  return sanitizeBusiness(business);
};

const saveSetupAddress = async (userId, { addressDetails, timezone }) => {
  const business = await Business.findOne({ userId });
  if (!business) {
    throw new ApiError(404, "Business setup has not been started.", {
      code: ERROR_CODES.BUSINESS_NOT_FOUND,
    });
  }

  business.addressDetails = addressDetails;
  business.address = formatAddress(addressDetails);
  business.timezone = timezone;
  business.onboardingStep = Math.max(business.onboardingStep || 0, 2);
  await business.save();
  return sanitizeBusiness(business);
};

const matchSetupPlaces = async ({ businessName, phone, pincode, city, state, address }) => {
  if (!placesService.isConfigured()) {
    throw new ApiError(501, "Google Places is not configured on this server.");
  }

  const query = [businessName, phone, address, city, state, pincode]
    .filter(Boolean)
    .join(" ")
    .trim();
  const places = await placesService.searchMultiple(query, 5);
  return places
    .map((place) => {
      const hasPhoneMatch = phoneMatches(phone, place.internationalPhoneNumber);
      const hasPincodeMatch =
        pincode && place.formattedAddress && place.formattedAddress.includes(pincode);
      return {
        placeId: place.placeId,
        name: place.displayName || "",
        formattedAddress: place.formattedAddress,
        phone: place.internationalPhoneNumber,
        website: place.website,
        rating: place.rating,
        userRatingCount: place.userRatingCount,
        googleMapsUri: place.googleMapsUri,
        matchReason: hasPhoneMatch
          ? "name_phone"
          : hasPincodeMatch
          ? "name_pincode"
          : "fallback",
      };
    })
    .sort((a, b) => {
      const rank = { name_phone: 0, name_pincode: 1, fallback: 2 };
      return rank[a.matchReason] - rank[b.matchReason];
    });
};

const selectSetupPlace = async (userId, { placeId }) => {
  const business = await Business.findOne({ userId });
  if (!business) {
    throw new ApiError(404, "Business setup has not been started.", {
      code: ERROR_CODES.BUSINESS_NOT_FOUND,
    });
  }
  if (!placesService.isConfigured()) {
    throw new ApiError(501, "Google Places is not configured on this server.");
  }

  await enrichWithGooglePlaces(business, { placeId });
  business.onboardingStep = Math.max(business.onboardingStep || 0, 3);
  await business.save();
  return {
    business: sanitizeBusiness(business),
    suggestions: await profileSuggestionsForBusiness(business),
  };
};

const completeSetup = async (userId, payload) => {
  const business = await Business.findOne({ userId });
  if (!business) {
    throw new ApiError(404, "Business setup has not been started.", {
      code: ERROR_CODES.BUSINESS_NOT_FOUND,
    });
  }

  business.category = payload.category;
  business.subcategories = payload.subcategories || [];
  business.services = payload.services || [];
  business.description = payload.description || "";
  if (payload.website !== undefined) business.website = payload.website || "";
  if (payload.brandAssets) {
    business.brandAssets = {
      logoUrl: payload.brandAssets.logoUrl ?? business.brandAssets?.logoUrl ?? "",
      primaryColor: payload.brandAssets.primaryColor ?? business.brandAssets?.primaryColor ?? "",
      secondaryColor: payload.brandAssets.secondaryColor ?? business.brandAssets?.secondaryColor ?? "",
      theme: payload.brandAssets.theme
        ? {
            name: payload.brandAssets.theme.name ?? "",
            colors: payload.brandAssets.theme.colors ?? [],
            vibe: payload.brandAssets.theme.vibe ?? "",
          }
        : business.brandAssets?.theme ?? { name: "", colors: [], vibe: "" },
    };
  }

  const missing = [];
  if (!business.businessName?.trim()) missing.push("businessName");
  if (!business.phone?.trim()) missing.push("phone");
  if (!business.address?.trim()) missing.push("address");
  if (!business.addressDetails?.pincode?.trim()) missing.push("pincode");
  if (!business.timezone?.trim()) missing.push("timezone");
  if (!business.category?.trim()) missing.push("category");

  if (missing.length) {
    throw new ApiError(400, "Business setup is incomplete.", {
      code: ERROR_CODES.BUSINESS_INCOMPLETE,
      details: missing.map((field) => `${field} is required.`),
    });
  }

  business.isCompleted = true;
  business.onboardingStep = 7;
  await business.save();
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

  for (const f of [...REQUIRED_FIELDS, "subcategories", "services", "description", "website"]) {
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
  if (typeof payload.onboardingStep === "number") {
    business.onboardingStep = Math.max(business.onboardingStep || 0, payload.onboardingStep);
  }
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

const uploadLogo = async (userId, fileBuffer, mimeType) => {
  if (!cloudinaryService.isConfigured()) {
    throw new ApiError(501, "Cloudinary is not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET to .env");
  }

  const business = await Business.findOne({ userId });
  if (!business) {
    throw new ApiError(404, "Business profile not found.", { code: ERROR_CODES.BUSINESS_NOT_FOUND });
  }

  const { publicUrl } = await cloudinaryService.uploadBuffer(fileBuffer, {
    folder: "brand_logos",
    publicId: `logo_${business._id.toString()}`,
  });

  business.brandAssets = {
    ...business.brandAssets?.toObject?.() || business.brandAssets || {},
    logoUrl: publicUrl,
  };
  await business.save();

  logger.info("[business] logo uploaded to Cloudinary", { businessId: business._id.toString(), publicUrl });
  return { logoUrl: publicUrl };
};

const generateThemes = async (userId, { hasLogo, logoUrl }) => {
  if (!openaiService.isConfigured()) {
    throw new ApiError(501, "OpenAI is not configured (OPENAI_API_KEY missing).");
  }

  const business = await Business.findOne({ userId });
  if (!business) {
    throw new ApiError(404, "Business profile not found.", { code: ERROR_CODES.BUSINESS_NOT_FOUND });
  }

  logger.info("[business] generating color themes", {
    businessId: business._id.toString(),
    hasLogo,
  });

  const themes = await openaiService.generateColorThemes({
    businessName:  business.businessName,
    category:      business.category || "",
    subcategories: business.subcategories || [],
    description:   business.description || "",
    hasLogo:       !!hasLogo,
    logoUrl:       hasLogo ? (logoUrl || business.brandAssets?.logoUrl || "") : "",
  });

  if (!themes || themes.length === 0) {
    throw new ApiError(500, "Theme generation returned no results.");
  }

  business.savedThemes = themes;
  await business.save();

  return { themes };
};

const findBusinessDocumentByUserId = async (userId) => Business.findOne({ userId });

module.exports = {
  createBusiness,
  getBusinessByUserId,
  updateBusiness,
  updateBrandAssets,
  refreshGoogle,
  startSetup,
  saveSetupAddress,
  matchSetupPlaces,
  selectSetupPlace,
  completeSetup,
  searchPlaces,
  generateDescription,
  uploadLogo,
  generateThemes,
  findBusinessDocumentByUserId,
};
