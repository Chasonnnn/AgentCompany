import { mergeThinUiSnapshot, shouldIncludeColleaguesForTick } from "./thin_snapshot.js";

const STORAGE_KEY = "agentcompany.desktop.session.v2";

const shell = document.querySelector(".slack-shell");
const form = document.getElementById("session-form");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const refreshBtn = document.getElementById("refresh-btn");
const toggleLiveBtn = document.getElementById("toggle-live-btn");
const statusText = document.getElementById("status-text");
const parseStateEl = document.getElementById("desktopParseState");
const sessionUrl = document.getElementById("session-url");
const errorEl = document.getElementById("error");
const frame = document.getElementById("dashboard-frame");
const livePane = document.getElementById("live-pane");
const threadTitleEl = document.getElementById("threadTitle");
const threadSubtitleEl = document.getElementById("threadSubtitle");
const threadStreamEl = document.getElementById("thread-stream");
const workspaceTitleEl = document.getElementById("workspaceTitle");
const workspaceSubEl = document.getElementById("workspaceSub");
const channelButtons = Array.from(document.querySelectorAll(".channel-btn[data-pane]"));
const colleagueList = document.getElementById("desktopColleagueList");
const pendingCountEl = document.getElementById("desktopPendingCount");
const runsCountEl = document.getElementById("desktopRunsCount");
const decisionsCountEl = document.getElementById("desktopDecisionsCount");
const bootstrapBtn = document.getElementById("bootstrapBtn");
const bootstrapStatusEl = document.getElementById("bootstrapStatus");
const quickCompanyNameInput = document.getElementById("quickCompanyName");
const quickProjectNameInput = document.getElementById("quickProjectName");
const quickIncludeDirectorInput = document.getElementById("quickIncludeDirector");
const quickForceResetInput = document.getElementById("quickForceReset");
const quickAutoStartInput = document.getElementById("quickAutoStart");
const departmentPresetListEl = document.getElementById("departmentPresetList");
const onboardAgentBtn = document.getElementById("onboardAgentBtn");
const onboardAgentStatusEl = document.getElementById("onboardAgentStatus");
const onboardAgentNameInput = document.getElementById("onboardAgentName");
const onboardAgentRoleInput = document.getElementById("onboardAgentRole");
const onboardAgentProviderInput = document.getElementById("onboardAgentProvider");
const onboardTeamIdInput = document.getElementById("onboardTeamId");
const onboardTeamNameInput = document.getElementById("onboardTeamName");

const DEPARTMENT_PRESETS = [
  { key: "engineering", label: "Engineering", enabled: true },
  { key: "product", label: "Product", enabled: true },
  { key: "design", label: "Design", enabled: false },
  { key: "operations", label: "Operations", enabled: true },
  { key: "qa", label: "QA", enabled: false },
  { key: "security", label: "Security", enabled: false },
  { key: "data", label: "Data", enabled: false }
];

let currentServerUrl = null;
let latestSnapshot = null;
let snapshotPollTimer = null;
let snapshotPollTick = 0;
let liveVisible = false;
let currentView = {
  pane: "pending",
  colleague_id: null
};

function getInvoke() {
  // Tauri v1 global API surface.
  const v1Invoke = window.__TAURI__?.core?.invoke;
  if (typeof v1Invoke === "function") {
    return v1Invoke;
  }

  // Tauri v2 internal bridge surface (available in packaged/dev desktop runtime).
  const v2InternalInvoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof v2InternalInvoke === "function") {
    return (command, args = {}) => v2InternalInvoke(command, args);
  }

  return null;
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

function parseIsoToMs(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function formatTime(value) {
  const ms = parseIsoToMs(value);
  if (!ms) return "recent";
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function setError(message) {
  errorEl.textContent = message ? String(message) : "";
}

function setBootstrapStatus(message, isError = false) {
  if (!bootstrapStatusEl) return;
  bootstrapStatusEl.textContent = message ? String(message) : "";
  bootstrapStatusEl.classList.toggle("error", isError);
}

function setOnboardStatus(message, isError = false) {
  if (!onboardAgentStatusEl) return;
  onboardAgentStatusEl.textContent = message ? String(message) : "";
  onboardAgentStatusEl.classList.toggle("error", isError);
}

function renderDepartmentPresetCheckboxes() {
  if (!departmentPresetListEl) return;
  departmentPresetListEl.innerHTML = DEPARTMENT_PRESETS
    .map(
      (preset) =>
        `<label><input type="checkbox" data-preset-key="${esc(preset.key)}" ${
          preset.enabled ? "checked" : ""
        } />${esc(preset.label)}</label>`
    )
    .join("");
}

function readSelectedDepartmentPresets() {
  return Array.from(document.querySelectorAll("[data-preset-key]"))
    .filter((el) => el instanceof HTMLInputElement && el.checked)
    .map((el) => String(el.getAttribute("data-preset-key") || "").trim())
    .filter(Boolean);
}

function setStatus(text) {
  statusText.textContent = text;
  statusText.classList.remove("running", "error", "warn");
  if (String(text).startsWith("running")) statusText.classList.add("running");
  if (String(text).startsWith("error")) statusText.classList.add("error");
}

function setCounts(pending = 0, runs = 0, decisions = 0) {
  pendingCountEl.textContent = String(pending);
  runsCountEl.textContent = String(runs);
  decisionsCountEl.textContent = String(decisions);
}

function setParseState(parseSummary) {
  const hasErrors = !!parseSummary?.has_parse_errors;
  parseStateEl.classList.remove("warn");
  if (!hasErrors) {
    parseStateEl.textContent = "none";
    return;
  }
  const total =
    Number(parseSummary?.pending_with_errors ?? 0) +
    Number(parseSummary?.decisions_with_errors ?? 0);
  const max = Number(parseSummary?.max_parse_error_count ?? 0);
  parseStateEl.textContent = `alerts ${total}/${max}`;
  parseStateEl.classList.add("warn");
}

function setColleaguePlaceholder(message = "Start a session to load colleagues.") {
  colleagueList.innerHTML =
    `<div style="font-size:12px;color:#98acc4;padding:3px 2px;">${esc(message)}</div>`;
}

function setActiveNav() {
  channelButtons.forEach((btn) => {
    const pane = btn.getAttribute("data-pane");
    const active = currentView.pane !== "colleague" && pane === currentView.pane;
    btn.classList.toggle("active", active);
  });
  Array.from(colleagueList.querySelectorAll("[data-colleague-id]")).forEach((btn) => {
    const active =
      currentView.pane === "colleague" &&
      btn.getAttribute("data-colleague-id") === currentView.colleague_id;
    btn.classList.toggle("active", active);
  });
}

function readViewDescriptor() {
  if (currentView.pane === "runs") {
    return {
      title: "# run-monitor",
      subtitle: "Live and historical run telemetry with budget/policy explainability."
    };
  }
  if (currentView.pane === "decisions") {
    return {
      title: "# recent-decisions",
      subtitle: "Manager approvals and denials from governed workflow execution."
    };
  }
  if (currentView.pane === "colleague" && currentView.colleague_id) {
    const colleague =
      latestSnapshot?.colleagues?.find((c) => c.agent_id === currentView.colleague_id) ?? null;
    const name = colleague?.name ? `@${colleague.name}` : `@${currentView.colleague_id}`;
    const role = colleague?.role ? ` (${roleLabel(colleague.role)})` : "";
    return {
      title: `${name}${role}`,
      subtitle: "Colleague timeline across runs, approvals, and comments."
    };
  }
  return {
    title: "# pending-approvals",
    subtitle: "Manager approvals queue for milestones and curated memory deltas."
  };
}

function buildPendingItems(snapshot) {
  const pending = snapshot?.review_inbox?.pending ?? [];
  return pending.map((p) => ({
    id: `pending-${p.artifact_id}`,
    ts: parseIsoToMs(p.created_at),
    time: formatTime(p.created_at),
    who: p.produced_by ? `@${p.produced_by}` : "@system",
    title: `${p.artifact_type} -> ${p.title || p.artifact_id}`,
    body: `Awaiting manager approval in project ${p.project_id}.`,
    tags: [
      p.visibility ? { text: p.visibility } : null,
      p.run_id ? { text: `run:${p.run_id}` } : null,
      p.parse_error_count > 0 ? { text: `parse:${p.parse_error_count}`, tone: "warn" } : null
    ].filter(Boolean)
  }));
}

function buildRunItems(snapshot) {
  const rows = snapshot?.monitor?.rows ?? [];
  return rows.map((r) => {
    const status =
      r.live_status === "running" ? "running" : r.run_status === "failed" ? "failed" : r.run_status;
    return {
      id: `run-${r.run_id}`,
      ts: parseIsoToMs(r.last_event?.ts_wallclock || r.created_at),
      time: formatTime(r.last_event?.ts_wallclock || r.created_at),
      who: r.agent_id ? `@${r.agent_id}` : "@system",
      title: `${r.run_id} (${status})`,
      body:
        `provider=${r.provider || "unknown"} · ` +
        `last=${r.last_event?.type || "none"} · ` +
        `policy_denied=${Number(r.policy_denied_count || 0)} · ` +
        `budget_hard=${Number(r.budget_exceeded_count || 0)}`,
      tags: [
        { text: r.run_status, tone: r.run_status === "failed" ? "bad" : r.run_status === "ended" ? "good" : null },
        r.live_status === "running" ? { text: "live", tone: "good" } : null,
        r.token_usage?.total_tokens ? { text: `tok:${r.token_usage.total_tokens}` } : null,
        typeof r.token_usage?.cost_usd === "number"
          ? { text: `usd:${r.token_usage.cost_usd.toFixed(4)}` }
          : null,
        r.parse_error_count > 0 ? { text: `parse:${r.parse_error_count}`, tone: "warn" } : null
      ].filter(Boolean)
    };
  });
}

function buildDecisionItems(snapshot) {
  const rows = snapshot?.review_inbox?.recent_decisions ?? [];
  return rows.map((d) => ({
    id: `decision-${d.review_id}`,
    ts: parseIsoToMs(d.created_at),
    time: formatTime(d.created_at),
    who: `@${d.actor_id}`,
    title: `${d.decision.toUpperCase()} ${d.subject_kind} -> ${d.subject_artifact_id}`,
    body: d.notes ? d.notes : `project=${d.project_id}`,
    tags: [
      d.actor_role ? { text: d.actor_role } : null,
      d.artifact_type ? { text: d.artifact_type } : null,
      d.run_id ? { text: `run:${d.run_id}` } : null,
      d.parse_error_count > 0 ? { text: `parse:${d.parse_error_count}`, tone: "warn" } : null,
      d.decision === "approved" ? { text: "approved", tone: "good" } : { text: "denied", tone: "bad" }
    ].filter(Boolean)
  }));
}

function buildColleagueItems(snapshot, colleagueId) {
  const runItems = (snapshot?.monitor?.rows ?? [])
    .filter((r) => r.agent_id === colleagueId)
    .map((r) => ({
      id: `colleague-run-${r.run_id}`,
      ts: parseIsoToMs(r.last_event?.ts_wallclock || r.created_at),
      time: formatTime(r.last_event?.ts_wallclock || r.created_at),
      who: `@${colleagueId}`,
      title: `Run ${r.run_id}`,
      body: `${r.provider || "unknown"} · status=${r.run_status} · event=${r.last_event?.type || "none"}`,
      tags: [
        { text: r.run_status, tone: r.run_status === "failed" ? "bad" : r.run_status === "ended" ? "good" : null },
        r.parse_error_count > 0 ? { text: `parse:${r.parse_error_count}`, tone: "warn" } : null
      ].filter(Boolean)
    }));

  const decisionItems = (snapshot?.review_inbox?.recent_decisions ?? [])
    .filter((d) => d.actor_id === colleagueId)
    .map((d) => ({
      id: `colleague-decision-${d.review_id}`,
      ts: parseIsoToMs(d.created_at),
      time: formatTime(d.created_at),
      who: `@${colleagueId}`,
      title: `${d.decision.toUpperCase()} ${d.subject_artifact_id}`,
      body: d.notes || `role=${d.actor_role}`,
      tags: [
        { text: d.decision, tone: d.decision === "approved" ? "good" : "bad" },
        d.subject_kind ? { text: d.subject_kind } : null
      ].filter(Boolean)
    }));

  const commentItems = (snapshot?.comments ?? [])
    .filter((c) => c.target?.agent_id === colleagueId)
    .map((c) => ({
      id: `colleague-comment-${c.id}`,
      ts: parseIsoToMs(c.created_at),
      time: formatTime(c.created_at),
      who: `@${c.author_id}`,
      title: `Comment for @${colleagueId}`,
      body: c.body,
      tags: [
        c.author_role ? { text: c.author_role } : null,
        c.visibility ? { text: c.visibility } : null
      ].filter(Boolean)
    }));

  return [...runItems, ...decisionItems, ...commentItems];
}

function buildThreadItems(snapshot) {
  if (!snapshot) return [];
  if (currentView.pane === "runs") return buildRunItems(snapshot);
  if (currentView.pane === "decisions") return buildDecisionItems(snapshot);
  if (currentView.pane === "colleague" && currentView.colleague_id) {
    return buildColleagueItems(snapshot, currentView.colleague_id);
  }
  return buildPendingItems(snapshot);
}

function renderThread(snapshot) {
  const descriptor = readViewDescriptor();
  threadTitleEl.textContent = descriptor.title;
  threadSubtitleEl.textContent = descriptor.subtitle;

  const items = buildThreadItems(snapshot).sort((a, b) => {
    if (a.ts !== b.ts) return b.ts - a.ts;
    return String(a.id).localeCompare(String(b.id));
  });
  if (!items.length) {
    threadStreamEl.innerHTML =
      '<div class="empty-thread">No activity yet for this channel. Start a session or refresh snapshots.</div>';
    return;
  }

  threadStreamEl.innerHTML = items
    .map((item) => {
      const tagHtml = (item.tags ?? [])
        .map((t) => {
          const tone = t.tone ? ` ${esc(t.tone)}` : "";
          return `<span class="tag${tone}">${esc(t.text)}</span>`;
        })
        .join("");
      return (
        `<article class="thread-item">` +
        `<div class="thread-meta"><span class="thread-who">${esc(item.who)}</span><span class="thread-time">${esc(item.time)}</span></div>` +
        `<h3 class="thread-title">${esc(item.title)}</h3>` +
        `<p class="thread-body">${esc(item.body)}</p>` +
        `<div class="tag-row">${tagHtml}</div>` +
        `</article>`
      );
    })
    .join("");
}

function renderColleagues(snapshot) {
  const colleagues = snapshot?.colleagues || [];
  if (!colleagues.length) {
    setColleaguePlaceholder("No colleagues found in this project.");
    if (currentView.pane === "colleague") {
      currentView = { pane: "pending", colleague_id: null };
    }
    setActiveNav();
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
  setActiveNav();
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
  renderThread(snapshot);

  const workspaceDir = String(snapshot?.workspace_dir || "").trim();
  const projectId = String(document.getElementById("project")?.value || "").trim();
  workspaceTitleEl.textContent = projectId ? `Project ${projectId}` : "AgentCompany";
  workspaceSubEl.textContent = workspaceDir || "Local-first governed agent org";
}

function postSelectionToFrame() {
  const win = frame?.contentWindow;
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

function updateFrameSrc(force = false) {
  if (!frame) return;
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
  renderThread(latestSnapshot);
  updateFrameSrc();
  postSelectionToFrame();
}

function setSessionUrl(url, forceFrameReload = false) {
  if (!url) {
    currentServerUrl = null;
    sessionUrl.textContent = "-";
    sessionUrl.setAttribute("href", "#");
    updateFrameSrc(true);
    return;
  }

  const next = String(url);
  const changed = currentServerUrl !== next;
  currentServerUrl = next;
  sessionUrl.textContent = next;
  sessionUrl.setAttribute("href", next);
  updateFrameSrc(forceFrameReload || changed);
}

function normalizeSession(raw) {
  const workspace_dir = String(raw.workspace || "").trim();
  const project_id = String(raw.project || "").trim();
  const actor_id = String(raw.actor || "human_ceo").trim() || "human_ceo";
  const actor_role = "ceo";
  const portNum = Number.parseInt(String(raw.port || "8787"), 10);
  const port = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : 8787;

  return {
    workspace_dir,
    project_id,
    actor_id,
    actor_role,
    actor_team_id: undefined,
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
  document.getElementById("actor").value = session.actor_id ?? "human_ceo";
  document.getElementById("role").value = "ceo";
  document.getElementById("team").value = "";
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
      // Keep polling.
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

async function refreshSnapshotSidebar(options = {}) {
  if (!currentServerUrl) return;
  const includeColleagues =
    options.includeColleagues === true || currentView.pane === "colleague";
  try {
    const [monitor, inbox, fullUi] = await Promise.all([
      fetchMonitorSnapshot(currentServerUrl),
      fetchInboxSnapshot(currentServerUrl),
      includeColleagues ? fetchUiSnapshot(currentServerUrl) : Promise.resolve(null)
    ]);
    const snap = mergeThinUiSnapshot({
      monitor,
      inbox,
      fullUi,
      previousSnapshot: latestSnapshot
    });
    renderSidebar(snap);
    setError("");
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

function ensureSnapshotPolling() {
  if (snapshotPollTimer) return;
  snapshotPollTimer = setInterval(() => {
    snapshotPollTick += 1;
    const includeColleagues =
      currentView.pane === "colleague" ||
      shouldIncludeColleaguesForTick(snapshotPollTick, latestSnapshot?.colleagues?.length > 0);
    void refreshSnapshotSidebar({ includeColleagues });
  }, 5000);
}

async function refreshStatus() {
  const invoke = getInvoke();
  if (!invoke) {
    setStatus("browser mode");
    setError("Tauri runtime not detected. Launch this page from the desktop app.");
    renderThread(latestSnapshot);
    return;
  }
  try {
    const status = await invoke("manager_web_status");
    if (!status?.running) {
      setStatus("idle");
      setSessionUrl(null);
      return;
    }
    setStatus(`running (${status.pid ?? "-"})`);
    setSessionUrl(status.url);
    await refreshSnapshotSidebar({ includeColleagues: true });
  } catch (error) {
    setStatus("error");
    setError(error instanceof Error ? error.message : String(error));
  }
}

async function bootstrapWorkspaceFromPresets() {
  const invoke = getInvoke();
  if (!invoke) {
    setBootstrapStatus("Tauri runtime not detected.", true);
    return;
  }

  const workspaceDir = String(document.getElementById("workspace")?.value || "").trim();
  if (!workspaceDir) {
    setBootstrapStatus("Workspace directory is required before bootstrapping.", true);
    return;
  }

  const departments = readSelectedDepartmentPresets();
  if (!departments.length) {
    setBootstrapStatus("Select at least one department preset.", true);
    return;
  }

  const args = {
    workspaceDir,
    companyName: String(quickCompanyNameInput?.value || "AgentCompany").trim() || "AgentCompany",
    projectName:
      String(quickProjectNameInput?.value || "AgentCompany Ops").trim() || "AgentCompany Ops",
    departments,
    includeCeo: true,
    includeDirector: Boolean(quickIncludeDirectorInput?.checked),
    force: Boolean(quickForceResetInput?.checked)
  };

  bootstrapBtn.disabled = true;
  setBootstrapStatus("Bootstrapping workspace...");
  try {
    const res = await invoke("bootstrap_workspace", { args });
    const defaults = res?.default_session ?? {};
    const projectId = String(defaults.project_id || res?.project_id || "").trim();
    const actorId = String(res?.agents?.ceo_agent_id || defaults.actor_id || "human_ceo");

    if (projectId) document.getElementById("project").value = projectId;
    document.getElementById("actor").value = actorId;
    document.getElementById("role").value = "ceo";
    document.getElementById("team").value = "";

    const session = readForm();
    saveSession(session);
    const deptCount = Array.isArray(res?.departments) ? res.departments.length : departments.length;
    setBootstrapStatus(
      `Created ${deptCount} departments, project ${projectId || "unknown"}, CEO actor ${actorId}.`
    );
    setError("");

    if (quickAutoStartInput?.checked) {
      await startSession();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    setBootstrapStatus(msg, true);
  } finally {
    bootstrapBtn.disabled = false;
  }
}

async function onboardAgent() {
  const invoke = getInvoke();
  if (!invoke) {
    setOnboardStatus("Tauri runtime not detected.", true);
    return;
  }

  const workspaceDir = String(document.getElementById("workspace")?.value || "").trim();
  if (!workspaceDir) {
    setOnboardStatus("Workspace directory is required before onboarding agents.", true);
    return;
  }

  const name = String(onboardAgentNameInput?.value || "").trim();
  const role = String(onboardAgentRoleInput?.value || "").trim().toLowerCase();
  const provider = String(onboardAgentProviderInput?.value || "").trim();
  const teamId = String(onboardTeamIdInput?.value || "").trim();
  const teamName = String(onboardTeamNameInput?.value || "").trim();

  if (!name) {
    setOnboardStatus("Agent name is required.", true);
    return;
  }
  if (!provider) {
    setOnboardStatus("Provider is required.", true);
    return;
  }
  if (!["ceo", "director", "manager", "worker"].includes(role)) {
    setOnboardStatus("Role must be one of: ceo, director, manager, worker.", true);
    return;
  }

  onboardAgentBtn.disabled = true;
  setOnboardStatus("Onboarding agent...");
  try {
    const res = await invoke("onboard_agent", {
      args: {
        workspaceDir,
        name,
        role,
        provider,
        teamId: teamId || undefined,
        teamName: teamName || undefined
      }
    });
    const createdTeam = Boolean(res?.created_team);
    const createdTeamId = String(res?.team_id || teamId || "").trim();
    if (!teamId && createdTeamId && onboardTeamIdInput) {
      onboardTeamIdInput.value = createdTeamId;
    }
    setOnboardStatus(
      `Onboarded ${name} (${role}) -> ${String(res?.agent_id || "unknown")}` +
        (createdTeam ? ` in new team ${createdTeamId}` : createdTeamId ? ` in team ${createdTeamId}` : "")
    );
    if (onboardAgentNameInput) onboardAgentNameInput.value = "";
    if (currentServerUrl) {
      await refreshSnapshotSidebar({ includeColleagues: true });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    setOnboardStatus(msg, true);
  } finally {
    onboardAgentBtn.disabled = false;
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
    setStatus(`running (${status.pid ?? "-"})`);
    setSessionUrl(url, true);
    snapshotPollTick = 0;
    await refreshSnapshotSidebar({ includeColleagues: true });
    if (liveVisible) updateFrameSrc(true);
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
    latestSnapshot = null;
    setCounts(0, 0, 0);
    setParseState(null);
    setColleaguePlaceholder();
    renderThread(null);
    currentView = { pane: "pending", colleague_id: null };
    setActiveNav();
    setError("");
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    stopBtn.disabled = false;
  }
}

function toggleLivePane() {
  liveVisible = !liveVisible;
  livePane.classList.toggle("hidden", !liveVisible);
  shell.classList.toggle("with-live", liveVisible);
  if (liveVisible) updateFrameSrc(true);
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

toggleLiveBtn.addEventListener("click", () => {
  toggleLivePane();
});

bootstrapBtn?.addEventListener("click", () => {
  void bootstrapWorkspaceFromPresets();
});

onboardAgentBtn?.addEventListener("click", () => {
  void onboardAgent();
});

const saved = loadSession();
if (saved) writeForm(saved);
renderDepartmentPresetCheckboxes();
setColleaguePlaceholder();
setCounts(0, 0, 0);
setParseState(null);
setBootstrapStatus("");
setOnboardStatus("");
setActiveNav();
renderThread(null);
ensureSnapshotPolling();
void refreshStatus();
