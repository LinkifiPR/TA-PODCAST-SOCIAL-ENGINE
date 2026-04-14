const form = document.getElementById("run-form");
const sourceTextEl = document.getElementById("sourceText");
const videoUrlEl = document.getElementById("videoUrl");
const requestEl = document.getElementById("request");
const headshotFileEl = document.getElementById("headshotFile");
const runButton = document.getElementById("runButton");
const statusText = document.getElementById("statusText");
const agentsList = document.getElementById("agentsList");
const resultSummary = document.getElementById("resultSummary");
const resultsWrap = document.getElementById("results");
const resultCardTemplate = document.getElementById("resultCardTemplate");

let availableAgents = [];

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

async function loadAgents() {
  try {
    const response = await fetch("/api/agents");
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Failed to load agents.");
    }
    availableAgents = payload.agents || [];
    renderAgents(availableAgents);
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
    let headshotDataUrl = null;
    let headshotFilename = null;
    const file = headshotFileEl.files?.[0];
    if (file) {
      headshotDataUrl = await fileToDataUrl(file);
      headshotFilename = file.name;
    }

    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: sourceText,
        videoUrl: videoUrlEl.value.trim(),
        request: requestEl.value.trim(),
        selectedAgents: chosenAgents,
        headshotDataUrl,
        headshotFilename,
      }),
    });

    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Run failed.");
    }

    renderSummary(payload);
    renderResults(payload.results || []);

    if (payload.failedAgents > 0) {
      setStatus(`Completed with ${payload.failedAgents} failed agent(s).`, true);
    } else {
      setStatus("All agents completed successfully.");
    }
  } catch (err) {
    setStatus(err.message || "Unexpected error during run.", true);
  } finally {
    runButton.disabled = false;
  }
});

loadAgents();
