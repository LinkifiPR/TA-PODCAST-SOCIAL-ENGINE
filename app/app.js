const form = document.getElementById("run-form");
const sourceTextEl = document.getElementById("sourceText");
const videoUrlEl = document.getElementById("videoUrl");
const requestEl = document.getElementById("request");
const headshotFileEl = document.getElementById("headshotFile");
const runButton = document.getElementById("runButton");
const statusText = document.getElementById("statusText");
const agentsList = document.getElementById("agentsList");
const thumbnailSetupEl = document.getElementById("thumbnailSetup");
const thumbnailFormatEl = document.getElementById("thumbnailFormat");
const thumbnailFormatHintEl = document.getElementById("thumbnailFormatHint");
const thumbnailOverlayEl = document.getElementById("thumbnailOverlay");
const thumbnailHeadshotHintEl = document.getElementById("thumbnailHeadshotHint");
const thumbnailHeadshotEl = document.getElementById("thumbnailHeadshot");
const resultSummary = document.getElementById("resultSummary");
const resultsWrap = document.getElementById("results");
const resultCardTemplate = document.getElementById("resultCardTemplate");

let availableAgents = [];
let thumbnailOptions = null;

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.style.color = isError ? "var(--err)" : "var(--muted)";
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read uploaded file."));
    reader.readAsDataURL(file);
  });
}

function selectedAgents() {
  const checked = Array.from(
    agentsList.querySelectorAll("input[type='checkbox']:checked")
  );
  return checked.map((el) => el.value);
}

function isThumbnailSelected() {
  return selectedAgents().includes("yt-thumbnail-generator");
}

function renderAgents(agents) {
  agentsList.innerHTML = "";

  if (!agents.length) {
    agentsList.textContent = "No enabled agents found.";
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const agent of agents) {
    const row = document.createElement("label");
    row.className = "agent-option";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.value = agent.id;
    check.checked = true;

    const text = document.createElement("span");
    text.textContent = `${agent.name} (${agent.executor})`;

    row.append(check, text);
    fragment.appendChild(row);
  }

  agentsList.appendChild(fragment);
  agentsList.addEventListener("change", () => {
    updateThumbnailSetupVisibility();
  });
}

function renderSummary(payload) {
  resultSummary.classList.remove("hidden");
  resultSummary.innerHTML = `
    <div>
      <h2 class="summary-title">Run Complete</h2>
      <p class="summary-meta">Run ID: ${payload.runId}</p>
    </div>
    <div class="summary-meta">
      Agents: ${payload.totalAgents} • Failed: ${payload.failedAgents} • Generated: ${new Date(
        payload.generatedAt
      ).toLocaleString()}
    </div>
  `;
}

function renderArtifactImage(artifact) {
  const wrap = document.createElement("div");

  const img = document.createElement("img");
  img.src = artifact.dataUrl;
  img.alt = artifact.filename || "Generated thumbnail";
  img.className = "artifact-image";

  const link = document.createElement("a");
  link.href = artifact.dataUrl;
  link.download = artifact.filename || "thumbnail.png";
  link.textContent = `Download ${artifact.filename || "image"}`;
  link.className = "artifact-link";

  wrap.append(img, link);
  return wrap;
}

function renderResults(results) {
  resultsWrap.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const result of results) {
    const card = resultCardTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector(".result-title").textContent = result.name || result.agentId;

    const pill = card.querySelector(".result-pill");
    pill.textContent = result.ok ? "SUCCESS" : "ERROR";
    pill.classList.add(result.ok ? "ok" : "err");

    const output = card.querySelector(".output-text");
    output.textContent = result.ok
      ? result.outputText || "(No output text returned)"
      : result.error || "Unknown error";

    const artifactWrap = card.querySelector(".artifact-wrap");
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    for (const artifact of artifacts) {
      if (artifact?.type === "image" && artifact?.dataUrl) {
        artifactWrap.appendChild(renderArtifactImage(artifact));
      }
    }

    fragment.appendChild(card);
  }

  resultsWrap.appendChild(fragment);
}

function getAgentLabel(agentId) {
  const match = availableAgents.find((agent) => agent.id === agentId);
  return match ? match.name : agentId;
}

function renderThumbnailOptions(options) {
  thumbnailOptions = options;

  thumbnailFormatEl.innerHTML = "";
  for (const format of options.formats || []) {
    const opt = document.createElement("option");
    opt.value = format;
    opt.textContent = format;
    if (format === options.recommendedFormat) opt.selected = true;
    thumbnailFormatEl.appendChild(opt);
  }

  thumbnailFormatHintEl.textContent = `Recommended: ${options.recommendedFormat}. ${options.recommendedReason}`;

  thumbnailHeadshotEl.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "No specific headshot";
  thumbnailHeadshotEl.appendChild(noneOpt);

  const available = Array.isArray(options.availableHeadshots)
    ? options.availableHeadshots
    : [];
  for (const name of available) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === options.recommendedHeadshot) opt.selected = true;
    thumbnailHeadshotEl.appendChild(opt);
  }

  const hasUpload = Boolean(headshotFileEl.files?.[0]);
  const yesRadio = document.querySelector(
    "input[name='thumbnailHeadshotMode'][value='yes']"
  );
  const noRadio = document.querySelector(
    "input[name='thumbnailHeadshotMode'][value='no']"
  );
  const shouldUseHeadshot = hasUpload || options.headshotFit === "yes";
  if (shouldUseHeadshot) yesRadio.checked = true;
  else noRadio.checked = true;

  if (hasUpload) {
    thumbnailHeadshotHintEl.textContent =
      "You uploaded a headshot. If 'Yes' is selected, the uploaded file is used.";
  } else if (available.length) {
    thumbnailHeadshotHintEl.textContent =
      `Headshot fit: ${options.headshotFit}. Recommended: ${options.recommendedHeadshot || "none"}.`;
  } else {
    thumbnailHeadshotHintEl.textContent =
      `Headshot fit: ${options.headshotFit}. No local headshot library detected on server, upload one above if needed.`;
  }

  thumbnailOverlayEl.value = "";
}

async function loadThumbnailOptions() {
  const sourceText = sourceTextEl.value.trim();
  if (!sourceText) {
    thumbnailFormatHintEl.textContent = "Paste transcript first to get recommendations.";
    return;
  }

  const response = await fetch("/api/thumbnail-options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript: sourceText,
      request: requestEl.value.trim(),
    }),
  });
  const payload = await parseApiResponse(response);
  renderThumbnailOptions(payload);
}

async function updateThumbnailSetupVisibility() {
  if (!isThumbnailSelected()) {
    thumbnailSetupEl.classList.add("hidden");
    return;
  }

  thumbnailSetupEl.classList.remove("hidden");
  try {
    await loadThumbnailOptions();
  } catch (err) {
    thumbnailFormatHintEl.textContent =
      err.message || "Could not load thumbnail recommendations.";
  }
}

function getThumbnailConfig() {
  const selectedMode = document.querySelector(
    "input[name='thumbnailHeadshotMode']:checked"
  );
  if (!selectedMode) {
    throw new Error("Please answer the thumbnail question: use a headshot or not.");
  }

  const overlay = thumbnailOverlayEl.value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");

  return {
    formatName: thumbnailFormatEl.value || thumbnailOptions?.recommendedFormat || "ACCUSATION",
    includeHeadshot: selectedMode.value === "yes",
    selectedHeadshot: thumbnailHeadshotEl.value || "",
    textOverlay: overlay,
  };
}

async function parseApiResponse(response) {
  const raw = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    const detail =
      (payload && (payload.error || payload.message)) ||
      raw.slice(0, 220) ||
      "Request failed";
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }

  if (!payload || payload.ok !== true) {
    const detail =
      (payload && (payload.error || payload.message)) || "Run failed.";
    throw new Error(detail);
  }

  return payload;
}

async function runSingleAgent(payloadBase, agentId) {
  const response = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payloadBase,
      selectedAgents: [agentId],
      thumbnailConfig:
        agentId === "yt-thumbnail-generator" ? payloadBase.thumbnailConfig : undefined,
    }),
  });

  const payload = await parseApiResponse(response);
  const result = Array.isArray(payload.results) ? payload.results[0] : null;
  if (!result) {
    throw new Error(`No result returned for ${agentId}.`);
  }
  return result;
}

async function loadAgents() {
  try {
    const response = await fetch("/api/agents");
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Failed to load agents.");
    }
    availableAgents = payload.agents || [];
    renderAgents(availableAgents);
    await updateThumbnailSetupVisibility();
  } catch (err) {
    setStatus(err.message || "Could not load agents.", true);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const sourceText = sourceTextEl.value.trim();
  if (!sourceText) {
    setStatus("Please paste a transcript or topic first.", true);
    return;
  }

  const chosenAgents = selectedAgents();
  if (!chosenAgents.length) {
    setStatus("Select at least one agent.", true);
    return;
  }

  runButton.disabled = true;
  setStatus("Running agents...");
  resultSummary.classList.add("hidden");
  resultsWrap.innerHTML = "";

  try {
    const rawVideoUrl = videoUrlEl.value.trim();
    const videoUrl =
      rawVideoUrl && !/^https?:\/\//i.test(rawVideoUrl)
        ? `https://${rawVideoUrl}`
        : rawVideoUrl;

    let headshotDataUrl = null;
    let headshotFilename = null;
    const file = headshotFileEl.files?.[0];
    if (file) {
      headshotDataUrl = await fileToDataUrl(file);
      headshotFilename = file.name;
    }

    let thumbnailConfig = null;
    if (chosenAgents.includes("yt-thumbnail-generator")) {
      thumbnailConfig = getThumbnailConfig();
    }

    const payloadBase = {
      transcript: sourceText,
      videoUrl,
      request: requestEl.value.trim(),
      headshotDataUrl,
      headshotFilename,
      thumbnailConfig,
    };

    const results = [];
    for (let index = 0; index < chosenAgents.length; index += 1) {
      const agentId = chosenAgents[index];
      setStatus(`Running ${index + 1}/${chosenAgents.length}: ${getAgentLabel(agentId)}...`);
      try {
        const result = await runSingleAgent(payloadBase, agentId);
        results.push(result);
      } catch (err) {
        results.push({
          agentId,
          name: getAgentLabel(agentId),
          ok: false,
          error: err.message || "Run failed.",
          outputText: "",
          artifacts: [],
        });
      }
    }

    const failedAgents = results.filter((result) => !result.ok).length;
    const summary = {
      runId: new Date().toISOString().replace(/[:.]/g, "-"),
      generatedAt: new Date().toISOString(),
      totalAgents: results.length,
      failedAgents,
    };

    renderSummary(summary);
    renderResults(results);

    if (failedAgents > 0) {
      setStatus(`Completed with ${failedAgents} failed agent(s).`, true);
    } else {
      setStatus("All agents completed successfully.");
    }
  } catch (err) {
    setStatus(err.message || "Unexpected error during run.", true);
  } finally {
    runButton.disabled = false;
  }
});

sourceTextEl.addEventListener("blur", () => {
  if (isThumbnailSelected()) {
    updateThumbnailSetupVisibility();
  }
});

requestEl.addEventListener("blur", () => {
  if (isThumbnailSelected()) {
    updateThumbnailSetupVisibility();
  }
});

headshotFileEl.addEventListener("change", () => {
  if (isThumbnailSelected() && thumbnailOptions) {
    renderThumbnailOptions(thumbnailOptions);
  }
});

loadAgents();
