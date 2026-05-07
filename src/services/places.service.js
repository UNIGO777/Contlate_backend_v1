const env = require("../config/env");
const logger = require("../core/logger");

const PLACES_HOST = "https://places.googleapis.com/v1";

const PLACE_FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "internationalPhoneNumber",
  "nationalPhoneNumber",
  "websiteUri",
  "googleMapsUri",
  "rating",
  "userRatingCount",
  "businessStatus",
  "types",
  "primaryType",
  "primaryTypeDisplayName",
  "editorialSummary",
  "regularOpeningHours",
  "location",
];

const isConfigured = () => Boolean(env.google.placesApiKey);

const callPlaces = async (path, { method = "POST", body, fieldMask } = {}) => {
  const url = `${PLACES_HOST}${path}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": env.google.placesApiKey,
  };
  if (fieldMask) headers["X-Goog-FieldMask"] = fieldMask;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      json?.error?.message || `Google Places error (${res.status}).`
    );
    err.statusCode = res.status;
    err.details = json;
    throw err;
  }
  return json;
};

const searchByText = async (textQuery) => {
  const data = await callPlaces("/places:searchText", {
    method: "POST",
    body: { textQuery, maxResultCount: 1 },
    fieldMask: PLACE_FIELDS.map((f) => `places.${f}`).join(","),
  });
  return (data.places && data.places[0]) || null;
};

// Returns up to `maxResults` normalized results for a free-text query.
const searchMultiple = async (textQuery, maxResults = 5) => {
  if (!isConfigured()) return [];
  const data = await callPlaces("/places:searchText", {
    method: "POST",
    body: { textQuery, maxResultCount: Math.min(maxResults, 10) },
    fieldMask: PLACE_FIELDS.map((f) => `places.${f}`).join(","),
  });
  return (data.places || []).map(normalize).filter(Boolean);
};

const getPlaceDetails = async (placeId) => {
  const data = await callPlaces(`/places/${encodeURIComponent(placeId)}`, {
    method: "GET",
    fieldMask: PLACE_FIELDS.join(","),
  });
  return data || null;
};

const normalize = (place) => {
  if (!place) return null;
  return {
    placeId: place.id || "",
    formattedAddress: place.formattedAddress || "",
    website: place.websiteUri || "",
    internationalPhoneNumber:
      place.internationalPhoneNumber || place.nationalPhoneNumber || "",
    rating: typeof place.rating === "number" ? place.rating : null,
    userRatingCount:
      typeof place.userRatingCount === "number" ? place.userRatingCount : null,
    googleMapsUri: place.googleMapsUri || "",
    businessStatus: place.businessStatus || "",
    types: Array.isArray(place.types) ? place.types : [],
    primaryType: place.primaryType || "",
    primaryTypeDisplayName: place.primaryTypeDisplayName?.text || "",
    editorialSummary: place.editorialSummary?.text || "",
    regularOpeningHours: place.regularOpeningHours || null,
    location: place.location
      ? { lat: place.location.latitude, lng: place.location.longitude }
      : { lat: null, lng: null },
    displayName: place.displayName?.text || "",
  };
};

// Find a place by free text (business name + address). Returns normalized result or null.
const findBusiness = async ({ businessName, address, placeId } = {}) => {
  if (!isConfigured()) return null;
  try {
    if (placeId) {
      const detail = await getPlaceDetails(placeId);
      return normalize(detail);
    }
    const query = [businessName, address].filter(Boolean).join(", ").trim();
    if (!query) return null;
    const place = await searchByText(query);
    return normalize(place);
  } catch (err) {
    logger.warn("[places] lookup failed", {
      message: err.message,
      details: err.details,
    });
    throw err;
  }
};

module.exports = { isConfigured, findBusiness, searchMultiple, normalize };
