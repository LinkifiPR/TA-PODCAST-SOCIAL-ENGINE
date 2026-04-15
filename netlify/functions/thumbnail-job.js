const { connectLambda, getStore } = require("@netlify/blobs");
const { loadEnvFile } = require("./lib/env");

loadEnvFile();

const THUMBNAIL_JOB_STORE = "thumbnail-jobs";
const THUMBNAIL_JOB_INPUT_SUFFIX = ":input";

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function getBaseUrl(event) {
  if (typeof event.rawUrl === "string" && event.rawUrl) {
    try {
      return new URL(event.rawUrl).origin;
    } catch (_) {
      // fall through
    }
  }

  const proto =
    event.headers?.["x-forwarded-proto"] ||
    event.headers?.["X-Forwarded-Proto"] ||
    "https";
  const host =
    event.headers?.["x-forwarded-host"] ||
    event.headers?.["X-Forwarded-Host"] ||
    event.headers?.host ||
    process.env.URL?.replace(/^https?:\/\//, "");

  if (host) {
    return `${proto}://${host}`;
  }

  if (process.env.URL) return process.env.URL;
  if (process.env.DEPLOY_PRIME_URL) return process.env.DEPLOY_PRIME_URL;

  throw new Error("Could not determine the site URL for background thumbnail jobs.");
}

async function getJobStore(event) {
  if (typeof event?.blobs === "string" && event.blobs) {
    try {
      connectLambda(event);
    } catch (err) {
      console.warn(
        "thumbnail-job: unable to hydrate blobs context from lambda event",
        err?.message || err
      );
    }
  }
  return getStore(THUMBNAIL_JOB_STORE);
}

function getInputKey(jobId) {
  return `${jobId}${THUMBNAIL_JOB_INPUT_SUFFIX}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(200, { ok: true });
  }

  try {
    const store = await getJobStore(event);

    if (event.httpMethod === "GET") {
      const jobId =
        event.queryStringParameters?.jobId ||
        event.queryStringParameters?.id ||
        "";
      if (!jobId) {
        return json(400, { ok: false, error: "Missing thumbnail job id." });
      }

      const job = await store.get(jobId, { type: "json" });
      if (!job) {
        return json(404, { ok: false, error: "Thumbnail job not found." });
      }

      const { inputKey: _ignoredInputKey, ...publicJob } = job;

      return json(200, {
        ok: true,
        jobId,
        ...publicJob,
      });
    }

    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const body = JSON.parse(event.body || "{}");
    const transcript = String(body.transcript || "").trim();
    const topic = String(body.topic || "").trim();
    const sourceText = transcript || topic;
    if (!sourceText) {
      return json(400, { ok: false, error: "Provide transcript text or topic." });
    }

    const jobId = crypto.randomUUID();
    const inputKey = getInputKey(jobId);
    const createdAt = new Date().toISOString();

    await store.setJSON(inputKey, {
      transcript,
      topic,
      videoUrl: body.videoUrl || "[VIDEO_URL]",
      request: body.request || "Generate all sections unless explicitly told otherwise.",
      headshotDataUrl:
        typeof body.headshotDataUrl === "string" ? body.headshotDataUrl : null,
      headshotFilename:
        typeof body.headshotFilename === "string" ? body.headshotFilename : null,
      thumbnailConfig:
        body.thumbnailConfig && typeof body.thumbnailConfig === "object"
          ? body.thumbnailConfig
          : null,
    });

    await store.setJSON(jobId, {
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      inputKey,
    });

    const backgroundUrl = `${getBaseUrl(event)}/.netlify/functions/thumbnail-job-background`;
    const invokeResponse = await fetch(backgroundUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId,
      }),
    });

    if (!invokeResponse.ok && invokeResponse.status !== 202) {
      await store.setJSON(jobId, {
        status: "failed",
        createdAt,
        updatedAt: new Date().toISOString(),
        error: `Failed to start background thumbnail job (HTTP ${invokeResponse.status}).`,
      });
      try {
        await store.delete(inputKey);
      } catch (_) {
        // ignore cleanup failures
      }
      return json(500, {
        ok: false,
        error: "Could not start thumbnail generation.",
      });
    }

    return json(202, {
      ok: true,
      jobId,
      status: "queued",
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err.message || "Unexpected error while creating thumbnail job.",
    });
  }
};
