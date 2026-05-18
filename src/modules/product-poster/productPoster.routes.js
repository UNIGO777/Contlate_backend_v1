const express = require("express");
const multer = require("multer");
const checkBusiness = require("../../middlewares/checkBusiness.middleware");
const productPosterController = require("./productPoster.controller");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, and WebP images are allowed."));
    }
  },
});

const router = express.Router();

router.use(checkBusiness);

router.post("/generate", productPosterController.generate);
router.post("/product-image", upload.single("file"), productPosterController.uploadProductImage);
router.delete("/product-image/:filename", productPosterController.deleteProductImage);

module.exports = router;
