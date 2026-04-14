const fs = require("fs/promises");
const path = require("path");

function repoRoot() {
  return path.resolve(__dirname, "../../..");
}

async function normalizePromptPath(manifestPath, promptPath) {
  if (path.isAbsolute(promptPath)) {
    return promptPath;
  }

  const fromManifestDir = path.resolve(path.dirname(manifestPath), promptPath);
  const fromRepoRoot = path.resolve(repoRoot(), promptPath);
  try {
    await fs.access(fromManifestDir);
    return fromManifestDir;
  } catch (_) {
    return fromRepoRoot;
  }
}

async function loadManifest(manifestRelPath = "agents/manifest.json") {
  const manifestPath = path.resolve(repoRoot(), manifestRelPath);
  const raw = await fs.readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.agents)) {
    throw new Error("Invalid manifest: expected agents array");
  }

  const agents = [];
  for (const agent of parsed.agents) {
    agents.push({
      id: agent.id,
      name: agent.name || agent.id,
      enabled: agent.enabled !== false,
      model: agent.model || process.env.OPENAI_MODEL || "gpt-5.4",
      executor: agent.executor || "text",
      promptPath: await normalizePromptPath(manifestPath, agent.prompt_path),
    });
  }

  return { manifestPath, agents };
}

async function loadPrompt(promptPath) {
  return fs.readFile(promptPath, "utf8");
}

function filterAgents(allAgents, selectedIds) {
  const enabled = allAgents.filter((agent) => agent.enabled);
  if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
    return enabled;
  }

  const wanted = new Set(selectedIds.map((id) => String(id).trim()).filter(Boolean));
  const selected = enabled.filter((agent) => wanted.has(agent.id));
  const found = new Set(selected.map((agent) => agent.id));
  const missing = Array.from(wanted).filter((id) => !found.has(id));
  if (missing.length) {
    throw new Error(`Unknown or disabled agent id(s): ${missing.join(", ")}`);
  }

  return selected;
}

module.exports = {
  repoRoot,
  loadManifest,
  loadPrompt,
  filterAgents,
};
