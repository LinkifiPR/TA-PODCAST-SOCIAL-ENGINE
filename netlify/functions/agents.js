const { loadManifest } = require("./lib/agents");
const { loadEnvFile } = require("./lib/env");

loadEnvFile();

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(200, { ok: true });
  }

  if (event.httpMethod !== "GET") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const { agents } = await loadManifest();
    const enabled = agents
      .filter((agent) => agent.enabled)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        executor: agent.executor,
        model: agent.model,
      }));

    return json(200, { ok: true, agents: enabled });
  } catch (err) {
    return json(500, { ok: false, error: err.message || "Failed to load agents" });
  }
};
