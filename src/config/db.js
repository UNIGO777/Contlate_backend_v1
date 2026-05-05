const mongoose = require("mongoose");
const env = require("./env");
const logger = require("../core/logger");

let isConnected = false;

const connectDb = async () => {
  if (isConnected) {
    return mongoose.connection;
  }

  mongoose.set("strictQuery", true);

  await mongoose.connect(env.mongodbUri);

  isConnected = true;
  logger.info(`MongoDB connected: ${mongoose.connection.name}`);

  return mongoose.connection;
};

module.exports = {
  connectDb,
};
