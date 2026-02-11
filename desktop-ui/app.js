const STORAGE_KEY = "agentcompany.desktop.session.v1";

const form = document.getElementById("session-form");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const refreshBtn = document.getElementById("refresh-btn");
const statusText = document.getElementById("status-text");
const sessionUrl = document.getElementById("session-url");
const errorEl = document.getElementById("error");
const frame = document.getElementById("dashboard-frame");

function getInvoke() {
  return window.__TAURI__?.core?.invoke;
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

function setSessionUrl(url) {
  if (!url) {
    sessionUrl.textContent = "-";
    sessionUrl.setAttribute("href", "#");
    frame.setAttribute("src", "about:blank");
    return;
  }
  sessionUrl.textContent = url;
  sessionUrl.setAttribute("href", url);
  frame.setAttribute("src", url);
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
    setSessionUrl(url);
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
    setError("");
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    stopBtn.disabled = false;
  }
}

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
void refreshStatus();
