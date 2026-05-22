/**
 * Per-platform publishing limits — enforced at schedule creation and publish-now time.
 * Keeps the app within Meta's stated rate limits and avoids spam-detection triggers.
 *
 * Meta references:
 *   - Facebook Pages: ~25 posts / 24h
 *   - Instagram: ~25 posts / 24h via Content Publishing API
 */

const PUBLISHING_LIMITS = {
  facebook: {
    maxPerDay: 25,           // Meta hard limit for Pages
    minIntervalMinutes: 10,  // Minimum gap between posts to the same account
  },
  instagram: {
    maxPerDay: 25,
    minIntervalMinutes: 10,
  },
};

/**
 * Returns the limit config for a platform, or a safe default for unknown platforms.
 */
const getLimits = (platform) =>
  PUBLISHING_LIMITS[platform?.toLowerCase()] ?? { maxPerDay: 25, minIntervalMinutes: 10 };

module.exports = { PUBLISHING_LIMITS, getLimits };
