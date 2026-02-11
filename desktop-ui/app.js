const STORAGE_KEY = "agentcompany.desktop.session.v1";

const form = document.getElementById("session-form");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const refreshBtn = document.getElementById("refresh-btn");
const statusText = document.getElementById("status-text");
const sessionUrl = document.getElementById("session-url");
const errorEl = document.getElementById("error");
const frame = document.getElementById("dashboard-frame");
const channelButtons = Array.from(document.querySelectorAll(".channel-btn[data-pane]"));
const colleagueList = document.getElementById("desktopColleagueList");
const pendingCountEl = document.getElementById("desktopPendingCount");
const runsCountEl = document.getElementById("desktopRunsCount");
const decisionsCountEl = document.getElementById("desktopDecisionsCount");
const parseStateEl = document.getElementById("desktopParseState");

let currentServerUrl = null;
let latestSnapshot = null;
let snapshotPollTimer = null;
let snapshotPollTick = 0;
let currentView = {
  pane: "pending",
  colleague_id: null
};

function getInvoke() {
  return window.__TAURI__?.core?.invoke;
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function roleLabel(role) {
  return String(role || "agent").toUpperCase();
}

function setError(message) {
  errorEl.textContent = message ? String(message) : "";
}

function setStatus(text) {
  statusText.textContent = text;
  statusText.classList.remove("running", "error");
  if (text.startsWith("running")) statusText.classList.add("running");
  if (text === "error") statusText.classList.add("error");
}

function setCounts(pending = 0, runs = 0, decisions = 0) {
  pendingCountEl.textContent = String(pending);
  runsCountEl.textContent = String(runs);
  decisionsCountEl.textContent = String(decisions);
}

function setParseState(parseSummary) {
  const hasErrors = !!parseSummary?.has_parse_errors;
  if (!hasErrors) {
    parseStateEl.textContent = "none";
    parseStateEl.classList.remove("warn");
    return;
  }
  const total =
    Number(parseSummary?.pending_with_errors ?? 0) +
    Number(parseSummary?.decisions_with_errors ?? 0);
  const max = Number(parseSummary?.max_parse_error_count ?? 0);
  parseStateEl.textContent = `alerts ${total} (max ${max})`;
  parseStateEl.classList.add("warn");
}

function setColleaguePlaceholder(message = "Start a session to load colleagues.") {
  colleagueList.innerHTML =
    `<div style="font-size:12px;color:#9cb2cc;padding:4px 2px;">${esc(message)}</div>`;
}

function setActiveNav() {
  channelButtons.forEach((btn) => {
    const pane = btn.getAttribute("data-pane");
    const active = currentView.pane !== "colleague" && pane === currentView.pane;
    btn.classList.toggle("active", active);
  });

  Array.from(colleagueList.querySelectorAll("[data-colleague-id]"))
    .forEach((btn) => {
      const active =
        currentView.pane === "colleague" &&
        btn.getAttribute("data-colleague-id") === currentView.colleague_id;
      btn.classList.toggle("active", active);
    });
}

function buildFrameUrl(baseUrl) {
  const u = new URL(baseUrl);
  u.searchParams.set("pane", currentView.pane);
  if (currentView.pane === "colleague" && currentView.colleague_id) {
    u.searchParams.set("colleague_id", currentView.colleague_id);
  } else {
    u.searchParams.delete("colleague_id");
  }
  return u.toString();
}

function postSelectionToFrame() {
  const win = frame.contentWindow;
  if (!win) return;
  win.postMessage(
    {
      type: "agentcompany.select",
      pane: currentView.pane,
      colleague_id: currentView.colleague_id
    },
    "*"
  );
}

function updateFrameSrc(force = false) {
  if (!currentServerUrl) {
    frame.setAttribute("src", "about:blank");
    return;
  }
  const target = buildFrameUrl(currentServerUrl);
  if (force || frame.getAttribute("src") !== target) {
    frame.setAttribute("src", target);
  } else {
    postSelectionToFrame();
  }
}

function applyView(nextPane, nextColleagueId = null) {
  if (nextPane === "colleague") {
    currentView = {
      pane: "colleague",
      colleague_id: nextColleagueId || currentView.colleague_id
    };
  } else {
    currentView = {
      pane: nextPane,
      colleague_id: null
    };
  }

  setActiveNav();
  updateFrameSrc();
  postSelectionToFrame();
}

function clearSnapshotUI() {
  latestSnapshot = null;
  setCounts(0, 0, 0);
  setParseState(null);
  setColleaguePlaceholder();
  setActiveNav();
}

function setSessionUrl(url, forceFrameReload = false) {
  if (!url) {
    currentServerUrl = null;
    sessionUrl.textContent = "-";
    sessionUrl.setAttribute("href", "#");
    frame.setAttribute("src", "about:blank");
    clearSnapshotUI();
    return;
  }

  const asString = String(url);
  const changed = currentServerUrl !== asString;
  currentServerUrl = asString;
  sessionUrl.textContent = asString;
  sessionUrl.setAttribute("href", asString);
  updateFrameSrc(forceFrameReload || changed);
}

function normalizeSession(raw) {
  const workspace_dir = String(raw.workspace || "").trim();
  const project_id = String(raw.project || "").trim();
  const actor_id = String(raw.actor || "human").trim() || "human";
  const actor_role = String(raw.role || "manager").trim() || "manager";
  const actor_team_id = String(raw.team || "").trim();
  const portNum = Number.parseInt(String(raw.port || "8787"), 10);
  const port = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : 8787;

  return {
    workspace_dir,
    project_id,
    actor_id,
    actor_role,
    actor_team_id: actor_team_id || undefined,
    port,
    host: "127.0.0.1"
  };
}

function readForm() {
  const fd = new FormData(form);
  return normalizeSession(Object.fromEntries(fd.entries()));
}

function writeForm(session) {
  document.getElementById("workspace").value = session.workspace_dir ?? "";
  document.getElementById("project").value = session.project_id ?? "";
  document.getElementById("actor").value = session.actor_id ?? "human";
  document.getElementById("role").value = session.actor_role ?? "manager";
  document.getElementById("team").value = session.actor_team_id ?? "";
  document.getElementById("port").value = String(session.port ?? 8787);
}

function saveSession(session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function loadSession() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return normalizeSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function waitForHealth(url, timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`, { method: "GET" });
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}/api/health`);
}

async function fetchUiSnapshot(url) {
  const res = await fetch(`${url}/api/ui/snapshot`, { method: "GET" });
  if (!res.ok) throw new Error(`snapshot failed: ${res.status}`);
  return await res.json();
}

async function fetchMonitorSnapshot(url) {
  const res = await fetch(`${url}/api/monitor/snapshot`, { method: "GET" });
  if (!res.ok) throw new Error(`monitor snapshot failed: ${res.status}`);
  return await res.json();
}

async function fetchInboxSnapshot(url) {
  const res = await fetch(`${url}/api/inbox/snapshot`, { method: "GET" });
  if (!res.ok) throw new Error(`inbox snapshot failed: ${res.status}`);
  return await res.json();
}

function renderColleagues(snapshot) {
  const colleagues = snapshot?.colleagues || [];
  if (!colleagues.length) {
    setColleaguePlaceholder("No colleagues found in this project.");
    if (currentView.pane === "colleague") {
      currentView = { pane: "pending", colleague_id: null };
      updateFrameSrc();
    }
    return;
  }

  const hasCurrent = colleagues.some((c) => c.agent_id === currentView.colleague_id);
  if (currentView.pane === "colleague" && !hasCurrent) {
    currentView.colleague_id = colleagues[0].agent_id;
  }

  colleagueList.innerHTML = colleagues
    .map((c) => {
      const badge = c.pending_reviews > 0 ? c.pending_reviews : c.active_runs;
      return (
        `<button class="colleague-btn" data-colleague-id="${esc(c.agent_id)}">` +
        `<span class="colleague-main">` +
        `<span class="dot ${esc(c.status)}"></span>` +
        `<span class="colleague-name">@${esc(c.name)}<span class="role-tag">${esc(roleLabel(c.role))}</span></span>` +
        `</span>` +
        `<span class="count">${esc(String(badge || 0))}</span>` +
        `</button>`
      );
    })
    .join("");

  Array.from(colleagueList.querySelectorAll("[data-colleague-id]")).forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-colleague-id");
      if (!id) return;
      applyView("colleague", id);
    });
  });
}

function renderSidebar(snapshot) {
  latestSnapshot = snapshot;
  setCounts(
    snapshot?.review_inbox?.pending?.length ?? 0,
    snapshot?.monitor?.rows?.length ?? 0,
    snapshot?.review_inbox?.recent_decisions?.length ?? 0
  );
  setParseState(snapshot?.review_inbox?.parse_errors);
  renderColleagues(snapshot);
  setActiveNav();
}

async function refreshSnapshotSidebar(options = {}) {
  if (!currentServerUrl) return;
  try {
    const includeColleagues = options.includeColleagues === true;
    const [monitor, inbox, fullUi] = await Promise.all([
      fetchMonitorSnapshot(currentServerUrl),
      fetchInboxSnapshot(currentServerUrl),
      includeColleagues ? fetchUiSnapshot(currentServerUrl) : Promise.resolve(null)
    ]);
    const snap = {
      workspace_dir: fullUi?.workspace_dir ?? latestSnapshot?.workspace_dir ?? "",
      generated_at: fullUi?.generated_at ?? new Date().toISOString(),
      index_sync_worker:
        fullUi?.index_sync_worker ??
        latestSnapshot?.index_sync_worker ?? {
          enabled: false,
          pending_workspaces: 0
        },
      monitor,
      review_inbox: inbox,
      colleagues: fullUi?.colleagues ?? latestSnapshot?.colleagues ?? [],
      comments: fullUi?.comments ?? latestSnapshot?.comments ?? []
    };
    renderSidebar(snap);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

function ensureSnapshotPolling() {
  if (snapshotPollTimer) return;
  snapshotPollTimer = setInterval(() => {
    snapshotPollTick += 1;
    const includeColleagues =
      snapshotPollTick % 6 === 0 || !(latestSnapshot?.colleagues?.length > 0);
    void refreshSnapshotSidebar({ includeColleagues });
  }, 5000);
}

async function refreshStatus() {
  const invoke = getInvoke();
  if (!invoke) {
    setStatus("browser mode");
    setError("Tauri runtime not detected. Launch this page from the desktop app.");
    return;
  }
  try {
    const status = await invoke("manager_web_status");
    if (!status?.running) {
      setStatus("idle");
      setSessionUrl(null);
      return;
    }
    setStatus(`running (pid ${status.pid ?? "-"})`);
    setSessionUrl(status.url);
    await refreshSnapshotSidebar({ includeColleagues: true });
    setError("");
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

async function startSession() {
  const invoke = getInvoke();
  if (!invoke) {
    setError("Tauri runtime not detected.");
    return;
  }

  const session = readForm();
  if (!session.workspace_dir) {
    setError("Workspace directory is required.");
    return;
  }
  if (!session.project_id) {
    setError("Project ID is required.");
    return;
  }

  startBtn.disabled = true;
  try {
    saveSession(session);
    setStatus("starting");
    const status = await invoke("start_manager_web", { args: session });
    const url = String(status?.url || "");
    if (!url) throw new Error("Manager Web did not return a URL");
    await waitForHealth(url);
    setStatus(`running (pid ${status.pid ?? "-"})`);
    setSessionUrl(url, true);
    snapshotPollTick = 0;
    await refreshSnapshotSidebar({ includeColleagues: true });
    setError("");
  } catch (error) {
    setStatus("error");
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    startBtn.disabled = false;
  }
}

async function stopSession() {
  const invoke = getInvoke();
  if (!invoke) {
    setError("Tauri runtime not detected.");
    return;
  }

  stopBtn.disabled = true;
  try {
    await invoke("stop_manager_web");
    setStatus("idle");
    setSessionUrl(null);
    currentView = { pane: "pending", colleague_id: null };
    setError("");
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    stopBtn.disabled = false;
  }
}

frame.addEventListener("load", () => {
  postSelectionToFrame();
});

channelButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const pane = btn.getAttribute("data-pane");
    if (!pane) return;
    applyView(pane);
  });
});

startBtn.addEventListener("click", () => {
  void startSession();
});

stopBtn.addEventListener("click", () => {
  void stopSession();
});

refreshBtn.addEventListener("click", () => {
  void refreshStatus();
});

const saved = loadSession();
if (saved) writeForm(saved);
setColleaguePlaceholder();
setCounts(0, 0, 0);
setParseState(null);
setActiveNav();
ensureSnapshotPolling();
void refreshStatus();
