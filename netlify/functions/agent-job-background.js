const { connectLambda, getStore } = require("@netlify/blobs");
const { loadEnvFile } = require("./lib/env");
const { loadManifest, filterAgents } = require("./lib/agents");
const { generateTextAgentResult } = require("./lib/text-agent");

loadEnvFile();

const AGENT_JOB_STORE = "agent-jobs";

async function getJobStore(event) {
  connectLambda(event);
  return getStore(AGENT_JOB_STORE);
}

exports.handler = async (event) => {
  const store = await getJobStore(event);
  const body = JSON.parse(event.body || "{}");
  const jobId = String(body.jobId || "").trim();

  if (!jobId) {
    console.error("Missing jobId for background agent run.");
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
    const transcript = String(body.transcript || "").trim();
    const topic = String(body.topic || "").trim();
    const sourceText = transcript || topic;
    if (!sourceText) {
      throw new Error("Provide transcript text or topic.");
    }

    const selectedAgentIds = Array.isArray(body.selectedAgents) ? body.selectedAgents : [];
    const { agents } = await loadManifest();
    const selectedAgents = filterAgents(agents, selectedAgentIds);
    if (selectedAgents.length !== 1) {
      throw new Error("Background agent jobs require exactly one selected agent.");
    }

    const [agent] = selectedAgents;
    if (agent.executor !== "text") {
      throw new Error("Background agent jobs currently support text agents only.");
    }

    await mark({
      status: "running",
      agentId: agent.id,
    });

    const result = await generateTextAgentResult({
      agent,
      sourceText,
      videoUrl: String(body.videoUrl || "[VIDEO_URL]").trim() || "[VIDEO_URL]",
      request: String(body.request || "Generate all sections unless explicitly told otherwise."),
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
      error: err.message || "Background agent generation failed.",
    });
  }
};
