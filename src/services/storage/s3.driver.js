// S3 driver skeleton. Wire the AWS SDK when real keys are available.
// Keep the interface identical to local.driver.js.

const notImplemented = () => {
  const err = new Error("S3 driver is not implemented yet. Set STORAGE_PROVIDER=local for now.");
  err.statusCode = 501;
  throw err;
};

module.exports = {
  getPresignedUpload: async () => notImplemented(),
  head: async () => notImplemented(),
  remove: async () => notImplemented(),
};
