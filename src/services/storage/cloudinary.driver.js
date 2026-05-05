// Cloudinary driver skeleton. Implement using cloudinary SDK when keys are available.

const notImplemented = () => {
  const err = new Error("Cloudinary driver is not implemented yet. Set STORAGE_PROVIDER=local for now.");
  err.statusCode = 501;
  throw err;
};

module.exports = {
  getPresignedUpload: async () => notImplemented(),
  head: async () => notImplemented(),
  remove: async () => notImplemented(),
};
