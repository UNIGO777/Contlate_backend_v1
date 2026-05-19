const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const env = require("../config/env");
const User = require("../modules/user/user.model");
const Business = require("../modules/business/business.model");
const logger = require("./logger");

let io = null;

/**
 * Initialize Socket.IO on an existing HTTP server.
 * Adds JWT auth middleware and auto-joins user/business rooms.
 */
function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(","),
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // JWT auth middleware — mirrors auth.middleware.js logic
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("AUTH_TOKEN_MISSING"));

    try {
      const decoded = jwt.verify(token, env.jwtSecret);
      const user = await User.findById(decoded.id)
        .select("role plan suspendedAt deletedAt")
        .lean();

      if (!user || user.deletedAt) {
        return next(new Error("AUTH_USER_NOT_FOUND"));
      }
      if (user.suspendedAt) {
        return next(new Error("AUTH_SUSPENDED"));
      }

      socket.userId = decoded.id;
      socket.userPlan = user.plan;
      next();
    } catch {
      next(new Error("AUTH_TOKEN_INVALID"));
    }
  });

  io.on("connection", async (socket) => {
    // Auto-join user room
    socket.join(`user:${socket.userId}`);

    // Auto-join business room if user has a business
    try {
      const business = await Business.findOne({ userId: socket.userId })
        .select("_id")
        .lean();
      if (business) {
        socket.join(`business:${business._id}`);
      }
    } catch (err) {
      logger.warn("[socket] failed to lookup business for room join", {
        userId: socket.userId,
        error: err.message,
      });
    }

    logger.info("[socket] client connected", {
      userId: socket.userId,
      socketId: socket.id,
    });

    socket.on("disconnect", (reason) => {
      logger.info("[socket] client disconnected", {
        userId: socket.userId,
        socketId: socket.id,
        reason,
      });
    });
  });

  logger.info("[socket] Socket.IO initialized");
  return io;
}

/**
 * Returns the Socket.IO instance, or null if not yet initialized.
 * Callers should gracefully handle null (skip emit, rely on polling fallback).
 */
function getIO() {
  return io;
}

module.exports = { initSocket, getIO };
