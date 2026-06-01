const dns = require("dns");
const { URL } = require("url");
const mongoose = require("mongoose");
const env = require("./env");
const logger = require("../core/logger");

let isConnected = false;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Extract the SRV hostname from a mongodb+srv:// URI.
 * e.g. "mongodb+srv://u:p@cluster0.abc.mongodb.net/db" → "cluster0.abc.mongodb.net"
 */
const extractSrvHost = (uri) => {
  try {
    // URL constructor chokes on the +srv scheme, so swap it out temporarily
    const normalized = uri.replace("mongodb+srv://", "https://");
    return new URL(normalized).hostname;
  } catch {
    return null;
  }
};

/**
 * Test whether Node's current DNS resolver can perform an SRV lookup for
 * the Atlas cluster.  Returns { ok, ms, error }.
 */
const probeDns = (srvHost) =>
  new Promise((resolve) => {
    const start = Date.now();
    dns.resolveSrv(`_mongodb._tcp.${srvHost}`, (err, addresses) => {
      const ms = Date.now() - start;
      if (err) {
        resolve({ ok: false, ms, error: err.code || err.message });
      } else {
        resolve({ ok: true, ms, records: addresses.length });
      }
    });
  });

/**
 * Quick check: can we resolve a well-known hostname?
 * Used to distinguish "DNS is totally broken" from "just SRV is broken".
 */
const probeGeneralDns = () =>
  new Promise((resolve) => {
    dns.resolve4("google.com", (err) => resolve(!err));
  });

const FALLBACK_DNS = env.dnsFallbackServers || ["1.1.1.1", "8.8.8.8"];

/* ------------------------------------------------------------------ */
/*  Main connect function                                              */
/* ------------------------------------------------------------------ */

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

const connectDb = async () => {
  if (isConnected) {
    return mongoose.connection;
  }

  mongoose.set("strictQuery", true);

  const isSrv = env.mongodbUri.startsWith("mongodb+srv://");
  const srvHost = isSrv ? extractSrvHost(env.mongodbUri) : null;

  let usedFallbackDns = false;
  let usedFallbackUri = false;

  /* --- Step 1: DNS diagnostics (only for SRV URIs) --- */
  if (isSrv && srvHost) {
    const dnsResult = await probeDns(srvHost);

    if (dnsResult.ok) {
      logger.info("DNS probe passed", {
        host: srvHost,
        records: dnsResult.records,
        ms: dnsResult.ms,
      });
    } else {
      logger.warn("DNS SRV probe failed with system resolver", {
        host: srvHost,
        error: dnsResult.error,
        ms: dnsResult.ms,
      });

      const generalDnsOk = await probeGeneralDns();
      logger.info("General DNS (A-record) probe", {
        ok: generalDnsOk,
      });

      // Try switching to fallback DNS servers
      const originalServers = dns.getServers();
      dns.setServers(FALLBACK_DNS);
      logger.info("Switched to fallback DNS servers", {
        servers: FALLBACK_DNS,
      });

      const retryResult = await probeDns(srvHost);
      if (retryResult.ok) {
        logger.info("DNS probe passed with fallback servers", {
          host: srvHost,
          records: retryResult.records,
          ms: retryResult.ms,
        });
        usedFallbackDns = true;
        // Keep the fallback DNS servers — they work
      } else {
        logger.warn("DNS probe still fails with fallback servers", {
          error: retryResult.error,
        });
        // Restore original servers; we'll try the fallback URI instead
        dns.setServers(originalServers);
      }
    }
  }

  /* --- Step 2: Pick the connection URI --- */
  let uri = env.mongodbUri;

  // If DNS is still broken after fallback, try the direct URI (if provided)
  if (isSrv && srvHost && !usedFallbackDns) {
    // Re-check DNS one more time to see if the original URI will work
    const finalCheck = await probeDns(srvHost);
    if (!finalCheck.ok && env.mongodbUriFallback) {
      uri = env.mongodbUriFallback;
      usedFallbackUri = true;
      logger.info("Using fallback MongoDB URI (non-SRV)", {
        reason: "SRV resolution failed",
      });
    }
  }

  /* --- Step 3: Connect with retry --- */
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
      });

      isConnected = true;

      logger.info("MongoDB connected", {
        database: mongoose.connection.name,
        host: mongoose.connection.host,
        attempt,
        fallbackDns: usedFallbackDns,
        fallbackUri: usedFallbackUri,
      });

      // Listen for disconnection events so we can reset the flag
      mongoose.connection.on("disconnected", () => {
        isConnected = false;
        logger.warn("MongoDB disconnected");
      });

      mongoose.connection.on("error", (err) => {
        logger.error("MongoDB connection error", { message: err.message });
      });

      return mongoose.connection;
    } catch (err) {
      lastError = err;
      logger.warn(`MongoDB connection attempt ${attempt}/${MAX_RETRIES} failed`, {
        message: err.message,
        code: err.code,
      });

      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1); // 2s, 4s, 8s
        logger.info(`Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw new Error(
    `MongoDB connection failed after ${MAX_RETRIES} attempts: ${lastError.message}`
  );
};

module.exports = {
  connectDb,
};
