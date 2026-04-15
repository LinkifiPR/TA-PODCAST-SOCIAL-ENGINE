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

  try {
    const sourceText = String(body.transcript || body.topic || "").trim();
    if (!sourceText) {
      throw new Error("Provide transcript text or topic.");
    }

    await mark({ status: "running" });

    const result = await generateThumbnailResult({
      sourceText,
      request: String(body.request || "Generate all sections unless explicitly told otherwise."),
      headshotDataUrl:
        typeof body.headshotDataUrl === "string" ? body.headshotDataUrl : null,
      headshotFilename:
        typeof body.headshotFilename === "string" ? body.headshotFilename : null,
      thumbnailConfig:
        body.thumbnailConfig && typeof body.thumbnailConfig === "object"
          ? body.thumbnailConfig
          : null,
    });

    await mark({
      status: "completed",
      completedAt: new Date().toISOString(),
      result,
    });
  } catch (err) {
    await mark({
      status: "failed",
      completedAt: new Date().toISOString(),
      error: err.message || "Thumbnail generation failed.",
    });
  }
};
