const bcrypt = require("bcrypt");
const env = require("./env");
const logger = require("../core/logger");
const { ROLES } = require("../constants/roles");
const User = require("../modules/user/user.model");

// Ensures an admin user exists matching ADMIN_SEED_* env vars.
// - Creates the user if missing.
// - Promotes an existing user with this email to admin.
// - Resets the password if SEED_RESET_PASSWORD is truthy (off by default once
//   the account exists, so seeding doesn't silently rotate the password).
const seedAdmin = async () => {
  const { email, password, name } = env.adminSeed;
  if (!email || !password) {
    logger.info("[seedAdmin] skipped (ADMIN_SEED_EMAIL/PASSWORD not set)");
    return null;
  }

  const normalizedEmail = email.toLowerCase().trim();
  let user = await User.findOne({ email: normalizedEmail });

  if (!user) {
    const passwordHash = await bcrypt.hash(password, env.bcryptSaltRounds);
    user = await User.create({
      name: name || "PostEngine Admin",
      email: normalizedEmail,
      passwordHash,
      role: ROLES.ADMIN,
      isEmailVerified: true,
    });
    logger.info("[seedAdmin] created admin user", { email: normalizedEmail });
    return user;
  }

  let dirty = false;
  if (user.role !== ROLES.ADMIN) {
    user.role = ROLES.ADMIN;
    dirty = true;
  }
  if (!user.isEmailVerified) {
    user.isEmailVerified = true;
    dirty = true;
  }
  if (process.env.ADMIN_SEED_RESET_PASSWORD === "true") {
    user.passwordHash = await bcrypt.hash(password, env.bcryptSaltRounds);
    user.refreshTokens = [];
    dirty = true;
    logger.info("[seedAdmin] reset admin password", { email: normalizedEmail });
  }
  if (dirty) {
    await user.save();
    logger.info("[seedAdmin] updated existing admin user", { email: normalizedEmail });
  } else {
    logger.info("[seedAdmin] admin already configured", { email: normalizedEmail });
  }
  return user;
};

module.exports = { seedAdmin };
