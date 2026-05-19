const express = require("express");
const { getNotifications, markRead } = require("./notification.controller");

const router = express.Router();

router.get("/", getNotifications);
router.patch("/read", markRead);

module.exports = router;
