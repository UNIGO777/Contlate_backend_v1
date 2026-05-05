const express = require("express");
const checkBusinessMiddleware = require("../../middlewares/checkBusiness.middleware");
const usageLimitMiddleware = require("../../middlewares/usageLimit.middleware");
const validateMiddleware = require("../../middlewares/validate.middleware");
const uploadController = require("./upload.controller");
const {
  validatePrepareUploadInput,
  validateConfirmUploadInput,
} = require("./upload.validation");

const router = express.Router();

router.post(
  "/prepare",
  checkBusinessMiddleware,
  usageLimitMiddleware("uploadsCount"),
  validateMiddleware(validatePrepareUploadInput),
  uploadController.prepareUpload
);
router.post(
  "/confirm",
  validateMiddleware(validateConfirmUploadInput),
  uploadController.confirmUpload
);
router.get("/me", uploadController.listUploads);
router.delete("/:mediaAssetId", uploadController.deleteUpload);

module.exports = router;
