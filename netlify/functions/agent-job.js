const { connectLambda, getStore } = require("@netlify/blobs");
const { loadEnvFile } = require("./lib/env");
const { loadManifest, filterAgents } = require("./lib/agents");

loadEnvFile();

const AGENT_JOB_STORE = "agent-jobs";

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
      // continue
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

  if (host) return `${proto}://${host}`;
  if (process.env.URL) return process.env.URL;
  if (process.env.DEPLOY_PRIME_URL) return process.env.DEPLOY_PRIME_URL;

  throw new Error("Could not determine the site URL for background agent jobs.");
}

async function getJobStore(event) {
  connectLambda(event);
  return getStore(AGENT_JOB_STORE);
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
        return json(400, { ok: false, error: "Missing agent job id." });
      }

      const job = await store.get(jobId, { type: "json" });
      if (!job) {
        return json(404, { ok: false, error: "Agent job not found." });
      }

      return json(200, {
        ok: true,
        jobId,
        ...job,
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

    const selectedAgentIds = Array.isArray(body.selectedAgents) ? body.selectedAgents : [];
    const { agents } = await loadManifest();
    const selectedAgents = filterAgents(agents, selectedAgentIds);
    if (selectedAgents.length !== 1) {
      return json(400, {
        ok: false,
        error: "Background agent jobs require exactly one selected agent.",
      });
    }

    const [agent] = selectedAgents;
    if (agent.executor !== "text") {
      return json(400, {
        ok: false,
        error: "Background agent jobs currently support text agents only.",
      });
    }

    const jobId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await store.setJSON(jobId, {
      status: "queued",
      agentId: agent.id,
      createdAt,
      updatedAt: createdAt,
    });

    const backgroundUrl = `${getBaseUrl(event)}/.netlify/functions/agent-job-background`;
    const invokeResponse = await fetch(backgroundUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId,
        transcript,
        topic,
        videoUrl: body.videoUrl || "[VIDEO_URL]",
        request: body.request || "Generate all sections unless explicitly told otherwise.",
        selectedAgents: [agent.id],
      }),
    });

    if (!invokeResponse.ok && invokeResponse.status !== 202) {
      await store.setJSON(jobId, {
        status: "failed",
        agentId: agent.id,
        createdAt,
        updatedAt: new Date().toISOString(),
        error: `Failed to start background agent job (HTTP ${invokeResponse.status}).`,
      });
      return json(500, {
        ok: false,
        error: "Could not start background agent generation.",
      });
    }

    return json(202, {
      ok: true,
      jobId,
      agentId: agent.id,
      status: "queued",
    });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err.message || "Unexpected error while creating background agent job.",
    });
  }
};
