/**
 * One-time migration: encrypts all existing plaintext access tokens
 * in the SocialAccount collection.
 *
 * Usage:
 *   node src/scripts/encryptExistingTokens.js
 *
 * Safe to run multiple times — skips tokens that are already encrypted.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const env = require("../config/env");
const { encrypt, getVersion } = require("../core/tokenEncryption");

const MONGO_URI = env.mongoUri || process.env.MONGO_URI;

const isEncrypted = (token) => {
  if (!token) return true; // empty tokens don't need encryption
  // Encrypted format: version:iv:authTag:ciphertext (4 colon-separated parts)
  const parts = token.split(":");
  if (parts.length !== 4) return false;
  const version = parseInt(parts[0], 10);
  return !isNaN(version) && version > 0;
};

async function main() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI);
  console.log("Connected.");

  const SocialAccount = mongoose.connection.collection("socialaccounts");

  const cursor = SocialAccount.find({});
  let total = 0;
  let encrypted = 0;
  let skipped = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    total++;

    const updates = {};

    if (doc.accessToken && !isEncrypted(doc.accessToken)) {
      updates.accessToken = encrypt(doc.accessToken);
      updates.tokenVersion = 1;
    }

    if (doc.userAccessToken && !isEncrypted(doc.userAccessToken)) {
      updates.userAccessToken = encrypt(doc.userAccessToken);
    }

    if (Object.keys(updates).length > 0) {
      await SocialAccount.updateOne({ _id: doc._id }, { $set: updates });
      encrypted++;
      console.log(`  Encrypted tokens for ${doc.platform}/${doc.accountName} (${doc._id})`);
    } else {
      skipped++;
    }
  }

  console.log(`\nDone. Total: ${total}, Encrypted: ${encrypted}, Skipped (already encrypted or empty): ${skipped}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
