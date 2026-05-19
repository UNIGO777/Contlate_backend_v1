const env = require("../config/env");
const logger = require("../core/logger");

const BASE_URL = "https://api.dataforseo.com/v3";

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 24; // 2 minutes total
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [0, 5000, 15000];

/**
 * Build Authorization header for DataForSEO Basic Auth.
 */
function getAuthHeader() {
  const { login, password } = env.dataForSeo;
  const token = Buffer.from(`${login}:${password}`).toString("base64");
  return `Basic ${token}`;
}

/**
 * Make an authenticated request to DataForSEO.
 */
async function apiRequest(method, path, body = null) {
  const url = `${BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const text = await response.text();
    throw new DataForSEONetworkError(
      `DataForSEO API ${response.status}: ${text}`,
      response.status
    );
  }

  return response.json();
}

/**
 * Sleep helper.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Custom error classes for retry classification (Bug 3 fix).
 */
class DataForSEONetworkError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "DataForSEONetworkError";
    this.statusCode = statusCode;
    this.retryable = true;
  }
}

class DataForSEOTaskError extends Error {
  constructor(message, taskId) {
    super(message);
    this.name = "DataForSEOTaskError";
    this.taskId = taskId;
    this.retryable = false;
  }
}

class DataForSEOTimeoutError extends Error {
  constructor(message, taskId) {
    super(message);
    this.name = "DataForSEOTimeoutError";
    this.taskId = taskId;
    this.retryable = false;
  }
}

/**
 * Submit a task and poll until completion.
 * Used for Standard Queue (async) endpoints.
 * Returns { taskId, result } for a single task.
 */
async function submitAndPollTask(postPath, getPath, payload) {
  // Step 1 — Submit task
  const postResult = await apiRequest("POST", postPath, payload);

  const task = postResult?.tasks?.[0];
  if (!task || task.status_code !== 20100) {
    throw new DataForSEOTaskError(
      `DataForSEO task submission failed: ${task?.status_message || "unknown error"}`,
      task?.id
    );
  }

  const taskId = task.id;
  logger.info("DataForSEO task submitted", { taskId, path: postPath });

  // Step 2 — Poll for results
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const getResult = await apiRequest("GET", `${getPath}/${taskId}`);
    const resultTask = getResult?.tasks?.[0];

    if (!resultTask) continue;

    if (resultTask.status_code === 20000) {
      logger.info("DataForSEO task completed", { taskId, attempt });
      return resultTask.result;
    }

    // 40602 = Task In Queue, 40601 = Task Created — keep polling
    const POLL_CONTINUE_CODES = [20100, 40601, 40602];
    if (!POLL_CONTINUE_CODES.includes(resultTask.status_code) && resultTask.status_code >= 40000) {
      throw new DataForSEOTaskError(
        `DataForSEO task failed: ${resultTask.status_message || "unknown"} (code: ${resultTask.status_code})`,
        taskId
      );
    }

    // Still processing, continue polling
  }

  throw new DataForSEOTimeoutError(
    `DataForSEO task timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s (taskId: ${taskId})`,
    taskId
  );
}

/**
 * Submit multiple tasks in bulk and poll each one individually (Bug 1 fix).
 * DataForSEO creates one task per array item — we must track all task IDs.
 */
async function submitAndPollMultipleTasks(postPath, getPath, payload) {
  // Step 1 — Submit all tasks in one POST
  const postResult = await apiRequest("POST", postPath, payload);

  const tasks = postResult?.tasks || [];
  const taskEntries = [];

  for (const task of tasks) {
    if (!task || task.status_code !== 20100) {
      logger.warn("DataForSEO task submission failed for one item", {
        statusCode: task?.status_code,
        message: task?.status_message,
      });
      continue;
    }
    taskEntries.push({
      taskId: task.id,
      data: task.data,
    });
  }

  if (taskEntries.length === 0) {
    throw new DataForSEOTaskError(
      "DataForSEO: all task submissions failed",
      null
    );
  }

  logger.info(`DataForSEO ${taskEntries.length} tasks submitted`, {
    path: postPath,
  });

  // Step 2 — Poll each task individually
  const allResults = [];

  for (const entry of taskEntries) {
    let completed = false;

    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      await sleep(POLL_INTERVAL_MS);

      const getResult = await apiRequest("GET", `${getPath}/${entry.taskId}`);
      const resultTask = getResult?.tasks?.[0];

      if (!resultTask) continue;

      if (resultTask.status_code === 20000) {
        logger.info("DataForSEO task completed", {
          taskId: entry.taskId,
          attempt,
        });
        allResults.push({
          taskId: entry.taskId,
          data: entry.data,
          result: resultTask.result,
        });
        completed = true;
        break;
      }

      // 40602 = Task In Queue, 40601 = Task Created — keep polling
      const POLL_CONTINUE_CODES = [20100, 40601, 40602];
      if (!POLL_CONTINUE_CODES.includes(resultTask.status_code) && resultTask.status_code >= 40000) {
        logger.warn("DataForSEO task failed", {
          taskId: entry.taskId,
          statusCode: resultTask.status_code,
          message: resultTask.status_message,
        });
        completed = true; // actual failure, stop polling
        break;
      }
    }

    if (!completed) {
      logger.warn("DataForSEO task timed out", { taskId: entry.taskId });
    }
  }

  return allResults;
}

/**
 * Retry wrapper — retries on network/server errors only (Bug 3 fix).
 * Does NOT retry task failures or timeouts — those won't succeed on retry.
 */
async function withRetry(fn, context = "") {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (RETRY_DELAYS_MS[attempt] > 0) {
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
      return await fn();
    } catch (err) {
      // Don't retry non-retryable errors
      if (err.retryable === false) {
        throw err;
      }

      logger.warn(`DataForSEO attempt ${attempt + 1}/${MAX_RETRIES} failed`, {
        context,
        error: err.message,
      });

      if (attempt === MAX_RETRIES - 1) {
        throw err;
      }
    }
  }
}

/**
 * Build DataForSEO location name from city and state.
 * Format: "City,State,India"
 */
function buildLocationName(city, state) {
  const parts = [city, state, "India"].filter(Boolean);
  return parts.join(",");
}

/**
 * Get keyword search volumes using DataForSEO Keyword Data API (Standard Queue).
 * Bug 2 fix: robust result parsing.
 *
 * @param {string[]} keywords - Array of keyword strings
 * @param {string} locationName - e.g. "Bhopal,Madhya Pradesh,India"
 * @returns {Array} - Keywords with monthlyVolume and competition
 */
async function getKeywordVolumes(keywords, locationName) {
  const payload = [
    {
      keywords,
      location_name: locationName,
      language_name: "English",
    },
  ];

  const result = await withRetry(
    () =>
      submitAndPollTask(
        "/keywords_data/google_ads/search_volume/task_post",
        "/keywords_data/google_ads/search_volume/task_get",
        payload
      ),
    `getKeywordVolumes(${locationName})`
  );

  // Parse the result — DataForSEO returns a flat array of keyword objects directly
  const volumeData = [];
  const resultArray = Array.isArray(result) ? result : [];

  for (const item of resultArray) {
    if (item?.keyword) {
      volumeData.push({
        keyword: item.keyword,
        monthlyVolume: item.search_volume || 0,
        competition: item.competition || null,
      });
    }
  }

  logger.info(
    `DataForSEO keyword volumes fetched: ${volumeData.length} keywords`,
    { locationName }
  );

  return volumeData;
}

/**
 * Get local (Google Maps) rankings for keywords using SERP API (Standard Queue).
 * Bug 1 fix: submits all keywords, polls each task individually, extracts keyword from task data.
 *
 * @param {string[]} keywords - Array of keyword strings
 * @param {string} locationName - e.g. "Bhopal,Madhya Pradesh,India"
 * @param {string} businessName - The business name to find in rankings
 * @returns {Array} - Keywords with mapsRank and topBusiness
 */
async function getLocalRankings(keywords, locationName, businessName) {
  const payload = keywords.map((keyword) => ({
    keyword,
    location_name: locationName,
    language_name: "English",
    device: "mobile",
    os: "android",
    depth: 20,
  }));

  const taskResults = await withRetry(
    () =>
      submitAndPollMultipleTasks(
        "/serp/google/maps/task_post",
        "/serp/google/maps/task_get",
        payload
      ),
    `getLocalRankings(${locationName}, ${businessName})`
  );

  const rankings = [];
  const nameLower = businessName.toLowerCase();

  for (const taskResult of taskResults) {
    // Extract keyword from the task's submission data, not from the result
    const keyword = taskResult.data?.keyword || "";
    const items = taskResult.result?.[0]?.items || [];

    let mapsRank = null;
    let topBusiness = items[0]?.title || null;

    // Search for the business in the top 20 results
    for (let i = 0; i < items.length; i++) {
      const title = (items[i]?.title || "").toLowerCase();
      if (title.includes(nameLower) || nameLower.includes(title)) {
        mapsRank = i + 1;
        break;
      }
    }

    rankings.push({
      keyword,
      mapsRank,
      topBusiness,
    });
  }

  logger.info(
    `DataForSEO local rankings fetched: ${rankings.length} keywords`,
    { locationName, businessName }
  );

  return rankings;
}

module.exports = {
  getKeywordVolumes,
  getLocalRankings,
  buildLocationName,
};
