const crypto = require("crypto");

const STAGGER_WINDOW_MINUTES = 10; // ±10 minutes = 20-minute total window

/**
 * Calculate a deterministic stagger offset in minutes for a given user+account.
 * Returns a value between -STAGGER_WINDOW_MINUTES and +STAGGER_WINDOW_MINUTES.
 *
 * Same userId + socialAccountId always produces the same offset,
 * so the same user publishing to the same account always shifts by the same amount.
 */
function calculateStaggerOffset(userId, socialAccountId) {
  const input = `${userId}:${socialAccountId}:postengine-stagger`;
  const hash = crypto.createHash("sha256").update(input).digest();
  const hashInt = hash.readUInt32BE(0);
  const normalized = hashInt / 0xffffffff;
  return Math.round((normalized * 2 - 1) * STAGGER_WINDOW_MINUTES);
}

/**
 * Apply stagger to a user-selected schedule time.
 * @param {Date} userPreferredTime - The time the user selected
 * @param {string} userId
 * @param {string} socialAccountId
 * @returns {{ executionTime: Date, offsetMinutes: number }}
 */
function applyStagger(userPreferredTime, userId, socialAccountId) {
  const offsetMinutes = calculateStaggerOffset(userId, socialAccountId);
  const executionTime = new Date(userPreferredTime.getTime() + offsetMinutes * 60 * 1000);
  return { executionTime, offsetMinutes };
}

module.exports = { calculateStaggerOffset, applyStagger, STAGGER_WINDOW_MINUTES };
