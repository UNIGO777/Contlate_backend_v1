/**
 * PhonePe Standard Checkout (v2).
 *
 * Replaces the earlier integration, which used the salt-key / X-VERIFY scheme
 * against api.phonepe.com/apis/hermes. PhonePe has moved to OAuth2 client
 * credentials and a different host, so none of the old signing applies:
 *
 *   auth       POST {base}/v1/oauth/token          (form-urlencoded)
 *   pay        POST {base}/checkout/v2/pay         Authorization: O-Bearer <token>
 *   status     GET  {base}/checkout/v2/order/{id}/status
 *   webhook    Authorization header = SHA256(username:password)
 *
 * The webhook credentials are NOT the API credentials — they are a separate
 * username/password you choose in the PhonePe dashboard when registering the
 * callback URL.
 *
 * Docs:
 *   https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/authorization
 *   https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/order-status
 *   https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/webhook
 */
const crypto = require("crypto");
const env = require("../config/env");
const logger = require("../core/logger");

// The OAuth host differs from the API host in production, but not in sandbox.
const SANDBOX_BASE = "https://api-preprod.phonepe.com/apis/pg-sandbox";
const PROD_API_BASE = "https://api.phonepe.com/apis/pg";
const PROD_AUTH_BASE = "https://api.phonepe.com/apis/identity-manager";

const isProduction = () => env.phonepe.env === "production";
const apiBase = () => (isProduction() ? PROD_API_BASE : SANDBOX_BASE);
const authBase = () => (isProduction() ? PROD_AUTH_BASE : SANDBOX_BASE);

const isConfigured = () =>
  Boolean(env.phonepe.clientId && env.phonepe.clientSecret);

const sha256 = (str) => crypto.createHash("sha256").update(str).digest("hex");

/**
 * Constant-time compare that tolerates different lengths.
 *
 * crypto.timingSafeEqual throws outright when the buffers differ in length,
 * so calling it directly on untrusted input turns a failed signature check
 * into a 500 instead of a clean rejection.
 */
const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

// ── Auth token, cached ──────────────────────────────────────────────────────
// Tokens are valid for a while and PhonePe asks that they be reused until
// close to expiry rather than minted per request.
let cachedToken = null; // { token, expiresAtMs }
const TOKEN_SAFETY_WINDOW_MS = 60 * 1000;

const getAccessToken = async () => {
  if (!isConfigured()) {
    throw new Error("PhonePe is not configured on this server.");
  }

  if (cachedToken && Date.now() < cachedToken.expiresAtMs - TOKEN_SAFETY_WINDOW_MS) {
    return cachedToken.token;
  }

  const body = new URLSearchParams({
    client_id: env.phonepe.clientId,
    client_version: String(env.phonepe.clientVersion),
    client_secret: env.phonepe.clientSecret,
    grant_type: "client_credentials",
  });

  const res = await fetch(`${authBase()}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.access_token) {
    logger.error("[phonepe] token request failed", { status: res.status, json });
    const err = new Error(json?.message || "Could not authenticate with PhonePe.");
    err.statusCode = res.status;
    throw err;
  }

  // expires_at is an epoch in SECONDS, not a duration.
  cachedToken = {
    token: json.access_token,
    expiresAtMs: Number(json.expires_at) * 1000,
  };
  return cachedToken.token;
};

/** Drops the cached token — used when PhonePe rejects it mid-flight. */
const invalidateToken = () => {
  cachedToken = null;
};

/**
 * Authenticated call to the PhonePe API.
 * Retries once on 401 with a fresh token, since a cached token can expire
 * between the check above and PhonePe receiving the request.
 */
const phonepeFetch = async (path, { method = "GET", body } = {}, _retried = false) => {
  const token = await getAccessToken();

  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `O-Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));

  if (res.status === 401 && !_retried) {
    invalidateToken();
    return phonepeFetch(path, { method, body }, true);
  }

  if (!res.ok) {
    logger.error("[phonepe] request failed", { path, status: res.status, json });
    const err = new Error(json?.message || `PhonePe request failed (${res.status}).`);
    err.statusCode = res.status;
    err.details = json;
    throw err;
  }

  return json;
};

// ── Checkout ────────────────────────────────────────────────────────────────

// PhonePe rejects anything outside this range for Standard Checkout.
const MIN_EXPIRE_SECONDS = 300;
const MAX_EXPIRE_SECONDS = 3600;

/**
 * Create a hosted checkout and return where to send the user.
 *
 * @param {object} p
 * @param {string} p.merchantOrderId  our own id; must be unique per attempt
 * @param {number} p.amount           in RUPEES — converted to paise here
 * @param {string} p.redirectUrl      where PhonePe returns the user afterwards
 * @param {object} [p.metaInfo]       up to 5 udf1..udf5 strings, echoed back
 * @param {number} [p.expireAfter]    seconds, 300–3600
 */
const createCheckout = async ({
  merchantOrderId,
  amount,
  redirectUrl,
  metaInfo = {},
  expireAfter = 1200,
}) => {
  if (!merchantOrderId) throw new Error("merchantOrderId is required.");
  if (!amount || amount <= 0) throw new Error("A positive amount is required.");
  if (!redirectUrl) throw new Error("redirectUrl is required.");

  const expiry = Math.min(
    MAX_EXPIRE_SECONDS,
    Math.max(MIN_EXPIRE_SECONDS, Math.round(expireAfter))
  );

  const json = await phonepeFetch("/checkout/v2/pay", {
    method: "POST",
    body: {
      merchantOrderId,
      // Amounts are in paise everywhere in this API.
      amount: Math.round(amount * 100),
      expireAfter: expiry,
      metaInfo,
      paymentFlow: {
        type: "PG_CHECKOUT",
        merchantUrls: { redirectUrl },
      },
    },
  });

  if (!json.redirectUrl) {
    logger.error("[phonepe] pay returned no redirectUrl", { json });
    throw new Error("PhonePe did not return a checkout URL.");
  }

  return {
    redirectUrl: json.redirectUrl,
    orderId: json.orderId || "",
    state: json.state || "",
    expireAt: json.expireAt || null,
    merchantOrderId,
  };
};

/**
 * Current state of an order, straight from PhonePe.
 *
 * Worth calling even when a webhook has already arrived: a webhook can be
 * missed or replayed, and this is the authoritative answer.
 */
const getOrderStatus = async (merchantOrderId, { details = false } = {}) => {
  const query = details ? "?details=true" : "";
  const json = await phonepeFetch(
    `/checkout/v2/order/${encodeURIComponent(merchantOrderId)}/status${query}`
  );
  return {
    orderId: json.orderId || "",
    state: json.state || "",            // PENDING | COMPLETED | FAILED
    amount: json.amount ?? null,        // paise
    paymentDetails: json.paymentDetails || [],
    raw: json,
  };
};

// ── Webhook ─────────────────────────────────────────────────────────────────

const webhookConfigured = () =>
  Boolean(env.phonepe.webhookUsername && env.phonepe.webhookPassword);

/**
 * Verify an S2S callback and return its parsed body.
 *
 * PhonePe signs these with SHA256("username:password") using the credentials
 * registered against the callback URL in the dashboard — not the API client
 * secret, and not a hash of the body. The header is therefore constant per
 * merchant; it proves the caller knows the shared secret, nothing more, which
 * is why the order state is re-read from the API before anything is granted.
 *
 * @throws when the signature does not match
 */
const verifyWebhook = (rawBody, authorizationHeader) => {
  if (!webhookConfigured()) {
    throw new Error("PhonePe webhook credentials are not configured.");
  }

  const expected = sha256(
    `${env.phonepe.webhookUsername}:${env.phonepe.webhookPassword}`
  );

  // PhonePe sends the bare hex digest; tolerate a "SHA256 " prefix in case a
  // dashboard setting adds one.
  const received = String(authorizationHeader || "").replace(/^SHA256\s+/i, "").trim();

  if (!safeEqual(expected, received.toLowerCase())) {
    throw new Error("PhonePe webhook signature mismatch.");
  }

  try {
    return typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
  } catch {
    throw new Error("Invalid webhook body.");
  }
};

const EVENT_COMPLETED = "checkout.order.completed";
const EVENT_FAILED = "checkout.order.failed";

/**
 * Reduce a webhook body to what the subscription layer needs.
 * Returns null when the event carries no decision (e.g. still pending).
 */
const resolvePaymentOutcome = (body) => {
  const event = body?.event || "";
  const payload = body?.payload || {};
  const state = payload.state || "";

  const base = {
    merchantOrderId: payload.merchantOrderId || "",
    orderId: payload.orderId || "",
    amount: payload.amount ?? null,
    state,
    event,
  };

  if (event === EVENT_COMPLETED || state === "COMPLETED") {
    return { ...base, paid: true };
  }
  if (event === EVENT_FAILED || state === "FAILED") {
    return { ...base, paid: false };
  }
  return null; // PENDING — wait for the next webhook
};

module.exports = {
  isConfigured,
  webhookConfigured,
  getAccessToken,
  invalidateToken,
  createCheckout,
  getOrderStatus,
  verifyWebhook,
  resolvePaymentOutcome,
  EVENT_COMPLETED,
  EVENT_FAILED,
};
