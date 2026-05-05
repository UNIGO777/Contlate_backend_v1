const express = require("express");
const checkBusinessMiddleware = require("../../middlewares/checkBusiness.middleware");
const validateMiddleware = require("../../middlewares/validate.middleware");
const contentController = require("./content.controller");
const {
  validateContentPayload,
  validateContentUpdatePayload,
} = require("./content.validation");

const router = express.Router();

router.use(checkBusinessMiddleware);

router.post("/", validateMiddleware(validateContentPayload), contentController.createContent);
router.get("/", contentController.listMyContent);
router.get("/:contentId", contentController.getMyContentById);
router.patch(
  "/:contentId",
  validateMiddleware(validateContentUpdatePayload),
  contentController.updateMyContent
);
router.delete("/:contentId", contentController.deleteMyContent);

module.exports = router;
