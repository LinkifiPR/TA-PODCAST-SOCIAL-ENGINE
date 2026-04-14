const fs = require("fs/promises");
const path = require("path");

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (_) {
    return false;
  }
}

function candidateRoots() {
  const roots = [
    path.resolve(__dirname, "../../.."),
    path.resolve(__dirname, "../.."),
    path.resolve(__dirname, ".."),
    process.cwd(),
    process.env.LAMBDA_TASK_ROOT,
    "/var/task",
  ].filter(Boolean);

  // Keep order, remove duplicates.
  const seen = new Set();
  return roots.filter((root) => {
    const normalized = path.resolve(root);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

async function resolveManifestPath(manifestRelPath = "agents/manifest.json") {
  if (path.isAbsolute(manifestRelPath) && (await fileExists(manifestRelPath))) {
    return manifestRelPath;
  }

  const tried = [];
  for (const root of candidateRoots()) {
    const candidate = path.resolve(root, manifestRelPath);
    tried.push(candidate);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Manifest not found for '${manifestRelPath}'. Tried: ${tried.join(", ")}`
  );
}

async function normalizePromptPath(manifestPath, promptPath) {
  if (path.isAbsolute(promptPath)) {
    return promptPath;
  }

  const manifestDir = path.dirname(manifestPath);
  const projectRoot = path.resolve(manifestDir, "..");
  const fromManifestDir = path.resolve(manifestDir, promptPath);
  const fromProjectRoot = path.resolve(projectRoot, promptPath);

  if (await fileExists(fromManifestDir)) {
    return fromManifestDir;
  }
  return fromProjectRoot;
}

async function loadManifest(manifestRelPath = "agents/manifest.json") {
  const manifestPath = await resolveManifestPath(manifestRelPath);
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
  loadManifest,
  loadPrompt,
  filterAgents,
  resolveManifestPath,
  candidateRoots,
};
