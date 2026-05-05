const env = require("../config/env");
const local = require("./storage/local.driver");
const s3 = require("./storage/s3.driver");
const cloudinary = require("./storage/cloudinary.driver");

const drivers = { local, s3, cloudinary };

const getDriver = () => {
  const driver = drivers[env.storageProvider];
  if (!driver) throw new Error(`Unknown STORAGE_PROVIDER: ${env.storageProvider}`);
  return driver;
};

const getPresignedUpload = (args) => getDriver().getPresignedUpload(args);
const head = (storageKey) => getDriver().head(storageKey);
const remove = (storageKey) => getDriver().remove(storageKey);

module.exports = {
  provider: () => env.storageProvider,
  getPresignedUpload,
  head,
  remove,
  local, // exposed so app.js can mount local-only ingest routes
};
