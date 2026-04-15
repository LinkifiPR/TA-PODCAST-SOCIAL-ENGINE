const { connectLambda, getStore } = require("@netlify/blobs");
const { loadEnvFile } = require("./lib/env");
const { generateThumbnailResult } = require("./lib/thumbnail");

loadEnvFile();

const THUMBNAIL_JOB_STORE = "thumbnail-jobs";

async function getJobStore(event) {
  if (typeof event?.blobs === "string" && event.blobs) {
    try {
      connectLambda(event);
    } catch (err) {
      console.warn(
        "thumbnail-job-background: unable to hydrate blobs context from lambda event",
        err?.message || err
      );
    }
  }
  return getStore(THUMBNAIL_JOB_STORE);
}

exports.handler = async (event) => {
  const store = await getJobStore(event);
  const body = JSON.parse(event.body || "{}");
  const jobId = String(body.jobId || "").trim();

  if (!jobId) {
    console.error("Missing jobId for thumbnail background run.");
    return;
  }

  const mark = async (payload) => {
    const existing = (await store.get(jobId, { type: "json" })) || {};
    await store.setJSON(jobId, {
      ...existing,
      ...payload,
      updatedAt: new Date().toISOString(),
    });
  };

  const cleanupInput = async (inputKey) => {
    if (!inputKey) return;
    try {
      await store.delete(inputKey);
    } catch (_) {
      // best effort cleanup
    }
  };

  try {
    const existingJob = (await store.get(jobId, { type: "json" })) || {};
    const inputKey = String(existingJob.inputKey || "").trim();
    const storedInput = inputKey ? await store.get(inputKey, { type: "json" }) : null;
    const input = storedInput && typeof storedInput === "object" ? storedInput : body;

    const sourceText = String(input.transcript || input.topic || "").trim();
    if (!sourceText) {
      throw new Error("Provide transcript text or topic.");
    }

    await mark({ status: "running" });

    const result = await generateThumbnailResult({
      sourceText,
      request: String(
        input.request || "Generate all sections unless explicitly told otherwise."
      ),
      headshotDataUrl:
        typeof input.headshotDataUrl === "string" ? input.headshotDataUrl : null,
      headshotFilename:
        typeof input.headshotFilename === "string" ? input.headshotFilename : null,
      thumbnailConfig:
        input.thumbnailConfig && typeof input.thumbnailConfig === "object"
          ? input.thumbnailConfig
          : null,
    });

    await mark({
      status: "completed",
      completedAt: new Date().toISOString(),
      result,
    });

    await cleanupInput(inputKey);
  } catch (err) {
    await mark({
      status: "failed",
      completedAt: new Date().toISOString(),
      error: err.message || "Thumbnail generation failed.",
    });

    const existingJob = (await store.get(jobId, { type: "json" })) || {};
    const inputKey = String(existingJob.inputKey || "").trim();
    await cleanupInput(inputKey);
  }
};
