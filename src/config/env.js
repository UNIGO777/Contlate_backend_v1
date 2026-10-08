const path = require("path");
const dotenv = require("dotenv");

dotenv.config({
  path: path.resolve(process.cwd(), ".env"),
});

const requiredEnvVars = ["MONGODB_URI", "JWT_SECRET", "JWT_REFRESH_SECRET"];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: toInt(process.env.PORT, 5000),
  apiPrefix: process.env.API_PREFIX || "/api/v1",
  corsOrigin: process.env.CORS_ORIGIN || "*",
  appUrl: process.env.APP_URL || "http://localhost:5000",
  // Deep link scheme used after OAuth callback:
  // - Expo Go (dev):       exp://192.168.x.x:8081/--
  // - Dev build (dev):     postengine:/
  // - Production (app store): postengine:/
  mobileDeepLinkBase: process.env.MOBILE_DEEP_LINK_BASE || "postengine:/",

  mongodbUri: process.env.MONGODB_URI,
  // Optional: direct mongodb:// URI used when SRV resolution fails
  mongodbUriFallback: process.env.MONGODB_URI_FALLBACK || "",
  // Optional: comma-separated fallback DNS servers (default: 1.1.1.1,8.8.8.8)
  dnsFallbackServers: process.env.DNS_FALLBACK_SERVERS
    ? process.env.DNS_FALLBACK_SERVERS.split(",").map((s) => s.trim())
    : null,

  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "30d",
  bcryptSaltRounds: toInt(process.env.BCRYPT_SALT_ROUNDS, 10),

  otpTtlMinutes: toInt(process.env.OTP_TTL_MINUTES, 10),
  otpMaxAttempts: toInt(process.env.OTP_MAX_ATTEMPTS, 5),
  loginMaxAttempts: toInt(process.env.LOGIN_MAX_ATTEMPTS, 10),
  loginLockoutMinutes: toInt(process.env.LOGIN_LOCKOUT_MINUTES, 15),

  storageProvider: process.env.STORAGE_PROVIDER || "local",
  storagePublicBaseUrl:
    process.env.STORAGE_PUBLIC_BASE_URL || "http://localhost:5000/static",
  storageLocalDir: process.env.STORAGE_LOCAL_DIR || "./uploads",
  s3: {
    region: process.env.S3_REGION || "",
    bucket: process.env.S3_BUCKET || "",
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
    presignExpiresSeconds: toInt(process.env.S3_PRESIGN_EXPIRES_SECONDS, 300),
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || "",
    apiKey: process.env.CLOUDINARY_API_KEY || "",
    apiSecret: process.env.CLOUDINARY_API_SECRET || "",
    uploadFolder: process.env.CLOUDINARY_UPLOAD_FOLDER || "postly",
  },

  google: {
    placesApiKey: process.env.GOOGLE_PLACES_API_KEY || "",
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ||
      "http://localhost:5000/api/v1/business/gbp/callback",
    authRedirectUri:
      process.env.GOOGLE_AUTH_REDIRECT_URI ||
      "http://localhost:5000/api/v1/auth/social/google/callback",
  },

  // Google Business Profile Performance API has a tight per-project daily
  // quota, and these are daily-granularity metrics, so cached reads are the
  // default and refreshes are floored.
  gbp: {
    insightsTtlHours: toInt(process.env.GBP_INSIGHTS_TTL_HOURS, 24),
    insightsMinRefreshMinutes: toInt(process.env.GBP_INSIGHTS_MIN_REFRESH_MINUTES, 360),
    insightsWindowDays: toInt(process.env.GBP_INSIGHTS_WINDOW_DAYS, 30),
  },

  dataForSeo: {
    login: process.env.DATAFORSEO_LOGIN || "",
    password: process.env.DATAFORSEO_PASSWORD || "",
  },

  encryption: {
    tokenKey1: process.env.TOKEN_ENCRYPTION_KEY_1 || "",
    currentVersion: toInt(process.env.CURRENT_ENCRYPTION_VERSION, 1),
  },

  redis: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: toInt(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD || "",
    db: toInt(process.env.REDIS_DB, 0),
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model:  process.env.OPENAI_MODEL || "gpt-4o-mini",
    imageEffort: ["low", "medium", "high"].includes(process.env.POSTER_IMAGE_EFFORT)
      ? process.env.POSTER_IMAGE_EFFORT
      : "low",
  },

  instagram: {
    appId: process.env.INSTAGRAM_APP_ID || "",
    appSecret: process.env.INSTAGRAM_APP_SECRET || "",
    redirectUri:
      process.env.INSTAGRAM_REDIRECT_URI ||
      "http://localhost:5000/api/v1/social/auth/instagram/callback",
    scopes:
      process.env.INSTAGRAM_SCOPES ||
      "instagram_business_basic,instagram_business_content_publish",
    oauthStateSecret: process.env.INSTAGRAM_OAUTH_STATE_SECRET || process.env.JWT_SECRET,
  },

  meta: {
    appId: process.env.META_APP_ID || "",
    appSecret: process.env.META_APP_SECRET || "",
    redirectUri:
      process.env.META_REDIRECT_URI ||
      "http://localhost:5000/api/v1/social/oauth/meta/callback",
    authRedirectUri:
      process.env.META_AUTH_REDIRECT_URI ||
      "http://localhost:5000/api/v1/auth/social/meta/callback",
    graphVersion: process.env.META_GRAPH_VERSION || "v21.0",
    oauthStateSecret: process.env.META_OAUTH_STATE_SECRET || process.env.JWT_SECRET,
    // Verify token you enter in the Meta App Dashboard when subscribing to webhooks
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || "postengine-meta-webhook",
  },

  linkedin: {
    clientId:     process.env.LINKEDIN_CLIENT_ID     || "",
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || "",
    redirectUri:  process.env.LINKEDIN_REDIRECT_URI  || "http://localhost:5000/api/v1/social/oauth/linkedin/callback",
    oauthStateSecret: process.env.LINKEDIN_OAUTH_STATE_SECRET || process.env.JWT_SECRET,
  },

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  },

  phonepe: {
    merchantId:    process.env.PHONEPE_MERCHANT_ID || "",
    saltKey:       process.env.PHONEPE_SALT_KEY || "",
    saltKeyIndex:  toInt(process.env.PHONEPE_SALT_KEY_INDEX, 1),
    // Set PHONEPE_ENV=production to hit live endpoints; any other value uses sandbox
    env:           process.env.PHONEPE_ENV || "sandbox",
  },

  mail: {
    driver: process.env.MAIL_DRIVER || "console",
    from: process.env.MAIL_FROM || "Prachar <no-reply@prachar.local>",
    replyTo: process.env.MAIL_REPLY_TO || "",
    // Footer/CTA destinations. Anything left blank is omitted from the
    // email rather than rendered as a dead link, which hurts deliverability.
    siteUrl: process.env.MAIL_SITE_URL || "",
    privacyUrl: process.env.MAIL_PRIVACY_URL || "",
    termsUrl: process.env.MAIL_TERMS_URL || "",
    supportEmail: process.env.MAIL_SUPPORT_EMAIL || "",
    // List-Unsubscribe target; Gmail weighs its presence heavily.
    unsubscribeUrl: process.env.MAIL_UNSUBSCRIBE_URL || "",
    smtp: {
      host: process.env.SMTP_HOST || "",
      port: toInt(process.env.SMTP_PORT, 587),
      user: process.env.SMTP_USER || "",
      password: process.env.SMTP_PASSWORD || "",
      secure: toBool(process.env.SMTP_SECURE, false),
    },
    resendApiKey: process.env.RESEND_API_KEY || "",
  },

  adminSeed: {
    email: process.env.ADMIN_SEED_EMAIL || "",
    password: process.env.ADMIN_SEED_PASSWORD || "",
    name: process.env.ADMIN_SEED_NAME || "PostEngine Admin",
  },

  adminPanelOrigin: process.env.ADMIN_PANEL_ORIGIN || "http://localhost:5173",
};

module.exports = env;
