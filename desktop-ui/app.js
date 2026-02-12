const STORAGE_KEY = "agentcompany.desktop.session.pm.v2";

const workspaceRailBtn = document.getElementById("workspaceRailBtn");
const projectRailList = document.getElementById("projectRailList");
const projectAddBtn = document.getElementById("projectAddBtn");
const settingsBtn = document.getElementById("settingsBtn");
const scopeTitleEl = document.getElementById("scopeTitle");
const scopeSubEl = document.getElementById("scopeSub");
const homeViewBtn = document.getElementById("homeViewBtn");
const channelListEl = document.getElementById("channelList");
const dmListEl = document.getElementById("dmList");
const addChannelBtn = document.getElementById("addChannelBtn");
const addDmBtn = document.getElementById("addDmBtn");
const activitiesViewBtn = document.getElementById("activitiesViewBtn");
const resourcesViewBtn = document.getElementById("resourcesViewBtn");
const viewTitleEl = document.getElementById("viewTitle");
const viewSubtitleEl = document.getElementById("viewSubtitle");
const syncBtn = document.getElementById("syncBtn");
const liveOpsBtn = document.getElementById("liveOpsBtn");
const contentBodyEl = document.getElementById("contentBody");
const composerForm = document.getElementById("composerForm");
const composerInput = document.getElementById("composerInput");
const composerHint = document.getElementById("composerHint");
const participantListEl = document.getElementById("participantList");

const projectModal = document.getElementById("projectModal");
const projectForm = document.getElementById("projectForm");
const projectNameInput = document.getElementById("projectNameInput");
const projectReposInput = document.getElementById("projectReposInput");
const projectCancelBtn = document.getElementById("projectCancelBtn");

const channelModal = document.getElementById("channelModal");
const channelForm = document.getElementById("channelForm");
const channelNameInput = document.getElementById("channelNameInput");
const channelVisibilitySelect = document.getElementById("channelVisibilitySelect");
const channelTeamSelect = document.getElementById("channelTeamSelect");
const channelParticipantList = document.getElementById("channelParticipantList");
const channelCancelBtn = document.getElementById("channelCancelBtn");

const dmModal = document.getElementById("dmModal");
const dmForm = document.getElementById("dmForm");
const dmSearchInput = document.getElementById("dmSearchInput");
const dmAgentList = document.getElementById("dmAgentList");
const dmCancelBtn = document.getElementById("dmCancelBtn");

const settingsModal = document.getElementById("settingsModal");
const settingsForm = document.getElementById("settingsForm");
const workspaceInput = document.getElementById("workspaceInput");
const actorInput = document.getElementById("actorInput");
const settingsStatus = document.getElementById("settingsStatus");
const bootstrapBtn = document.getElementById("bootstrapBtn");
const openOnboardBtn = document.getElementById("openOnboardBtn");
const settingsCancelBtn = document.getElementById("settingsCancelBtn");

const onboardModal = document.getElementById("onboardModal");
const onboardForm = document.getElementById("onboardForm");
const onboardNameInput = document.getElementById("onboardNameInput");
const onboardRoleSelect = document.getElementById("onboardRoleSelect");
const onboardProviderSelect = document.getElementById("onboardProviderSelect");
const onboardTeamSelect = document.getElementById("onboardTeamSelect");
const onboardCancelBtn = document.getElementById("onboardCancelBtn");

const profileModal = document.getElementById("profileModal");
const profileNameEl = document.getElementById("profileName");
const profileMetaEl = document.getElementById("profileMeta");
const profileStatsEl = document.getElementById("profileStats");
const profileCloseBtn = document.getElementById("profileCloseBtn");
const profileMessageBtn = document.getElementById("profileMessageBtn");

const liveOpsModal = document.getElementById("liveOpsModal");
const liveOpsFrame = document.getElementById("liveOpsFrame");
const liveOpsCloseBtn = document.getElementById("liveOpsCloseBtn");

const state = {
  workspaceDir: "",
  actorId: "human_ceo",
  selectedRail: {
    kind: "workspace",
    projectId: null
  },
  selectedView: {
    type: "home",
    conversationId: null
  },
  projects: [],
  agents: [],
  teams: [],
  conversationsWorkspace: [],
  conversationsProject: [],
  messages: [],
  activitiesSnapshot: null,
  resourcesSnapshot: null,
  pmSnapshot: null,
  allocationRecommendations: [],
  profileAgentId: null,
  refreshBusy: false,
  pollTimer: null,
  selectedDmPeerId: null
};

function getInvoke() {
  const v1Invoke = window.__TAURI__?.core?.invoke;
  if (typeof v1Invoke === "function") return v1Invoke;
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

function setSettingsStatus(msg) {
  settingsStatus.textContent = msg || "";
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function fmtDate(value) {
  if (!value) return "recent";
  const t = Date.parse(String(value));
  if (!Number.isFinite(t)) return "recent";
  return new Date(t).toLocaleString();
}

function scopeParams() {
  if (state.selectedRail.kind === "project" && state.selectedRail.projectId) {
    return {
      scope: "project",
      project_id: state.selectedRail.projectId
    };
  }
  return { scope: "workspace" };
}

function currentConversations() {
  return state.selectedRail.kind === "project" ? state.conversationsProject : state.conversationsWorkspace;
}

function resolveAgent(agentId) {
  if (!agentId) return null;
  if (agentId === state.actorId || agentId === "human_ceo") {
    return { agent_id: agentId, name: "You", role: "ceo", provider: "manual" };
  }
  return state.agents.find((a) => a.agent_id === agentId) || null;
}

function parseRepoIds(raw) {
  return String(raw || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function saveSession() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      workspaceDir: state.workspaceDir,
      actorId: state.actorId,
      selectedRail: state.selectedRail,
      selectedView: state.selectedView
    })
  );
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.workspaceDir = String(parsed.workspaceDir || "");
    state.actorId = String(parsed.actorId || "human_ceo");
    if (parsed.selectedRail?.kind === "project" && parsed.selectedRail?.projectId) {
      state.selectedRail = { kind: "project", projectId: String(parsed.selectedRail.projectId) };
    }
    if (["home", "activities", "resources"].includes(parsed.selectedView?.type)) {
      state.selectedView = {
        type: parsed.selectedView.type,
        conversationId: null
      };
    } else if (parsed.selectedView?.type === "conversation" && parsed.selectedView?.conversationId) {
      state.selectedView = {
        type: "conversation",
        conversationId: String(parsed.selectedView.conversationId)
      };
    }
  } catch {
    // ignore malformed session
  }
}

async function rpcCall(method, params = {}) {
  const invoke = getInvoke();
  if (!invoke) throw new Error("Tauri runtime not detected. Launch from desktop app.");
  return invoke("rpc_call", {
    args: {
      method,
      params
    }
  });
}

async function refreshProjectsAgentsTeams() {
  const [projectsPayload, agents, teams] = await Promise.all([
    rpcCall("workspace.projects.list", {
      workspace_dir: state.workspaceDir
    }),
    rpcCall("workspace.agents.list", {
      workspace_dir: state.workspaceDir
    }),
    rpcCall("workspace.teams.list", {
      workspace_dir: state.workspaceDir
    })
  ]);

  state.projects = Array.isArray(projectsPayload?.projects) ? projectsPayload.projects : [];
  state.agents = Array.isArray(agents) ? agents : [];
  state.teams = Array.isArray(teams) ? teams : [];

  if (
    state.selectedRail.kind === "project" &&
    !state.projects.some((p) => p.project_id === state.selectedRail.projectId)
  ) {
    state.selectedRail = { kind: "workspace", projectId: null };
    state.selectedView = { type: "home", conversationId: null };
  }
}

async function refreshConversations() {
  if (!state.workspaceDir) return;

  state.conversationsWorkspace = await rpcCall("conversation.list", {
    workspace_dir: state.workspaceDir,
    scope: "workspace"
  });

  if (state.selectedRail.kind === "project" && state.selectedRail.projectId) {
    state.conversationsProject = await rpcCall("conversation.list", {
      workspace_dir: state.workspaceDir,
      scope: "project",
      project_id: state.selectedRail.projectId
    });
  } else {
    state.conversationsProject = [];
  }

  if (state.selectedView.type === "conversation") {
    const activeId = state.selectedView.conversationId;
    const exists = currentConversations().some((c) => c.id === activeId);
    if (!exists) {
      state.selectedView = { type: "home", conversationId: null };
    }
  }
}

async function refreshCurrentViewData() {
  if (!state.workspaceDir) return;

  if (state.selectedView.type === "home") {
    const params = scopeParams();
    state.pmSnapshot = await rpcCall("pm.snapshot", {
      workspace_dir: state.workspaceDir,
      ...params
    });
    state.resourcesSnapshot = await rpcCall("resources.snapshot", {
      workspace_dir: state.workspaceDir,
      project_id: params.project_id
    });
    state.messages = [];
    state.activitiesSnapshot = null;
    state.allocationRecommendations = [];
    if (params.scope === "project" && params.project_id) {
      const recs = await rpcCall("pm.recommend_allocations", {
        workspace_dir: state.workspaceDir,
        project_id: params.project_id
      });
      state.allocationRecommendations = Array.isArray(recs?.recommendations) ? recs.recommendations : [];
    }
    return;
  }

  if (state.selectedView.type === "conversation" && state.selectedView.conversationId) {
    const params = scopeParams();
    state.messages = await rpcCall("conversation.messages.list", {
      workspace_dir: state.workspaceDir,
      conversation_id: state.selectedView.conversationId,
      ...params,
      limit: 300
    });
    state.activitiesSnapshot = null;
    state.resourcesSnapshot = null;
    state.pmSnapshot = null;
    state.allocationRecommendations = [];
    return;
  }

  if (state.selectedView.type === "activities") {
    state.activitiesSnapshot = await rpcCall("ui.snapshot", {
      workspace_dir: state.workspaceDir,
      project_id: state.selectedRail.projectId ?? undefined,
      monitor_limit: 200,
      pending_limit: 200,
      decisions_limit: 200,
      sync_index: true
    });
    state.messages = [];
    state.resourcesSnapshot = null;
    state.pmSnapshot = null;
    state.allocationRecommendations = [];
    return;
  }

  if (state.selectedView.type === "resources") {
    state.resourcesSnapshot = await rpcCall("resources.snapshot", {
      workspace_dir: state.workspaceDir,
      project_id: state.selectedRail.projectId ?? undefined
    });
    state.messages = [];
    state.activitiesSnapshot = null;
    state.pmSnapshot = null;
    state.allocationRecommendations = [];
  }
}

function renderProjectRail() {
  workspaceRailBtn.classList.toggle("active", state.selectedRail.kind === "workspace");
  projectRailList.innerHTML = state.projects
    .map((p) => {
      const active = state.selectedRail.kind === "project" && state.selectedRail.projectId === p.project_id;
      const badge = p.pending_reviews > 0 ? p.pending_reviews : p.active_runs;
      return (
        `<button class="rail-item ${active ? "active" : ""}" data-project-id="${esc(p.project_id)}" type="button">` +
        `${esc((p.name || "").slice(0, 7) || "Project")}` +
        `${badge > 0 ? ` <span class="item-badge">${badge}</span>` : ""}` +
        `</button>`
      );
    })
    .join("");

  Array.from(projectRailList.querySelectorAll("[data-project-id]")).forEach((el) => {
    el.addEventListener("click", async () => {
      const projectId = el.getAttribute("data-project-id");
      if (!projectId) return;
      state.selectedRail = { kind: "project", projectId };
      state.selectedView = { type: "home", conversationId: null };
      await refreshAndRender();
    });
  });
}

function renderSidebar() {
  const project =
    state.selectedRail.kind === "project"
      ? state.projects.find((p) => p.project_id === state.selectedRail.projectId)
      : null;

  scopeTitleEl.textContent = project ? project.name : "Workspace";
  scopeSubEl.textContent = project
    ? "Project PM home, channels, DMs, operations"
    : "Portfolio home, cross-project operations";

  homeViewBtn.classList.toggle("active", state.selectedView.type === "home");

  const channels = currentConversations().filter((c) => c.kind === "channel");
  channelListEl.innerHTML = channels.length
    ? channels
        .map((c) => {
          const active = state.selectedView.type === "conversation" && state.selectedView.conversationId === c.id;
          return `<button class="sidebar-item ${active ? "active" : ""}" data-conversation-id="${esc(c.id)}" type="button"># ${esc(c.slug)}</button>`;
        })
        .join("")
    : `<div class="empty">No channels yet.</div>`;

  const dms = currentConversations().filter((c) => c.kind === "dm");
  dmListEl.innerHTML = dms.length
    ? dms
        .map((c) => {
          const peer = resolveAgent(c.dm_peer_agent_id) || { name: c.dm_peer_agent_id || "DM" };
          const active = state.selectedView.type === "conversation" && state.selectedView.conversationId === c.id;
          return `<button class="sidebar-item ${active ? "active" : ""}" data-conversation-id="${esc(c.id)}" type="button">@${esc(peer.name)}</button>`;
        })
        .join("")
    : `<div class="empty">No DMs yet.</div>`;

  activitiesViewBtn.classList.toggle("active", state.selectedView.type === "activities");
  resourcesViewBtn.classList.toggle("active", state.selectedView.type === "resources");

  Array.from(document.querySelectorAll("[data-conversation-id]")).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-conversation-id");
      if (!id) return;
      state.selectedView = { type: "conversation", conversationId: id };
      await refreshAndRenderCurrentView();
    });
  });
}

function renderParticipantsForConversation(conversation) {
  if (!conversation || !Array.isArray(conversation.participants?.agent_ids)) {
    participantListEl.innerHTML = `<div class="empty">No participants.</div>`;
    return;
  }
  const ids = [...new Set(conversation.participants.agent_ids)].filter(Boolean);
  if (!ids.length) {
    participantListEl.innerHTML = `<div class="empty">No participants.</div>`;
    return;
  }
  participantListEl.innerHTML = ids
    .map((id) => {
      const agent = resolveAgent(id);
      const canOpen = String(id).startsWith("agent_");
      return (
        `<button class="participant-item" data-agent-id="${canOpen ? esc(id) : ""}" type="button">` +
        `<div>${esc(agent?.name || id)}</div>` +
        `<div class="meta">${esc(agent?.role || "participant")} · ${esc(agent?.provider || "manual")}</div>` +
        `</button>`
      );
    })
    .join("");

  Array.from(participantListEl.querySelectorAll("[data-agent-id]")).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const agentId = btn.getAttribute("data-agent-id");
      if (!agentId) return;
      await openProfile(agentId);
    });
  });
}

function renderMessageView() {
  const conversation = currentConversations().find((c) => c.id === state.selectedView.conversationId);
  if (!conversation) {
    contentBodyEl.innerHTML = `<div class="empty">Select a channel or DM.</div>`;
    participantListEl.innerHTML = `<div class="empty">No participants.</div>`;
    composerForm.classList.add("hidden");
    return;
  }

  const prefix = conversation.kind === "channel" ? "#" : conversation.kind === "dm" ? "@" : "";
  viewTitleEl.textContent = `${prefix}${conversation.slug || conversation.name}`;
  viewSubtitleEl.textContent = conversation.kind === "dm" ? "Direct conversation" : "Channel timeline";

  if (!state.messages.length) {
    contentBodyEl.innerHTML = `<div class="empty">No messages yet.</div>`;
  } else {
    contentBodyEl.innerHTML = state.messages
      .map((m) => {
        const agent = resolveAgent(m.author_id);
        return (
          `<article class="message-card">` +
          `<div class="message-meta"><span class="message-author">${esc(agent?.name || m.author_id)}</span><span>${esc(fmtDate(m.created_at))}</span></div>` +
          `<p class="message-body">${esc(m.body)}</p>` +
          `</article>`
        );
      })
      .join("");
  }

  composerForm.classList.remove("hidden");
  composerHint.textContent = `Posting to ${conversation.slug || conversation.name}`;
  renderParticipantsForConversation(conversation);
}

function renderActivitiesView() {
  viewTitleEl.textContent = "Activities";
  viewSubtitleEl.textContent = "Approvals, run telemetry, and decisions";

  const snap = state.activitiesSnapshot || {};
  const pending = snap.review_inbox?.pending || [];
  const decisions = snap.review_inbox?.recent_decisions || [];
  const runs = snap.monitor?.rows || [];

  const items = [];
  for (const p of pending) {
    items.push({
      ts: p.created_at || "",
      title: `Pending approval: ${p.artifact_type} ${p.artifact_id}`,
      body: `${p.title || "Untitled"} · by ${p.produced_by || "unknown"}`
    });
  }
  for (const d of decisions) {
    items.push({
      ts: d.created_at || "",
      title: `${String(d.decision || "").toUpperCase()} ${d.subject_kind || "item"}`,
      body: `${d.subject_artifact_id || ""} · actor=${d.actor_id || "unknown"}`
    });
  }
  for (const r of runs) {
    items.push({
      ts: r.last_event?.ts_wallclock || r.created_at || "",
      title: `Run ${r.run_id} (${r.run_status})`,
      body: `${r.provider || "unknown"} · ${r.last_event?.type || "no events"}`
    });
  }

  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  contentBodyEl.innerHTML = items.length
    ? items
        .slice(0, 250)
        .map(
          (i) =>
            `<article class="activity-card"><div class="activity-meta"><span>${esc(i.title)}</span><span>${esc(fmtDate(i.ts))}</span></div><p class="activity-body">${esc(i.body)}</p></article>`
        )
        .join("")
    : `<div class="empty">No activities yet.</div>`;

  composerForm.classList.add("hidden");

  const colleagues = snap.colleagues || [];
  participantListEl.innerHTML = colleagues.length
    ? colleagues
        .slice(0, 60)
        .map(
          (c) =>
            `<button class="participant-item" data-agent-id="${esc(c.agent_id)}" type="button"><div>${esc(c.name)}</div><div class="meta">${esc(c.role)} · runs=${c.active_runs} · pending=${c.pending_reviews}</div></button>`
        )
        .join("")
    : `<div class="empty">No active colleagues.</div>`;

  Array.from(participantListEl.querySelectorAll("[data-agent-id]")).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const agentId = btn.getAttribute("data-agent-id");
      if (!agentId) return;
      await openProfile(agentId);
    });
  });
}

function renderResourcesView() {
  viewTitleEl.textContent = "Resources";
  viewSubtitleEl.textContent = "Token usage, workers, provider mix, context cycles";

  const r = state.resourcesSnapshot;
  if (!r) {
    contentBodyEl.innerHTML = `<div class="empty">No resource data available.</div>`;
    participantListEl.innerHTML = `<div class="empty">No participants.</div>`;
    composerForm.classList.add("hidden");
    return;
  }

  const kpis = [
    ["Agents", r.totals.agents],
    ["Workers", r.totals.workers],
    ["Active Workers", r.totals.active_workers],
    ["Runs Indexed", r.totals.runs_indexed],
    ["Total Tokens", r.totals.total_tokens],
    ["Total Cost (USD)", Number(r.totals.total_cost_usd || 0).toFixed(4)],
    ["Context Cycles", r.totals.context_cycles_total],
    ["Cycle Unknown Runs", r.totals.context_cycles_unknown_runs]
  ];

  const providerCards = (r.providers || [])
    .map(
      (p) =>
        `<article class="resource-card"><div class="activity-title">${esc(p.provider)}</div><p class="activity-body">runs=${p.run_count} · tokens=${p.total_tokens} · usd=${Number(p.total_cost_usd || 0).toFixed(4)}</p></article>`
    )
    .join("");

  const modelCards = (r.models || [])
    .map(
      (m) =>
        `<article class="resource-card"><div class="activity-title">${esc(m.model)}</div><p class="activity-body">agents=${m.agent_count}</p></article>`
    )
    .join("");

  contentBodyEl.innerHTML =
    `<section class="resource-grid">` +
    kpis
      .map(
        ([k, v]) =>
          `<article class="kpi"><div class="kpi-label">${esc(k)}</div><div class="kpi-value">${esc(String(v))}</div></article>`
      )
      .join("") +
    `</section>` +
    `<section><h3>Providers</h3>${providerCards || `<div class="empty">No provider usage yet.</div>`}</section>` +
    `<section><h3>Models</h3>${modelCards || `<div class="empty">No model metadata yet.</div>`}</section>`;

  participantListEl.innerHTML = `<div class="empty">Open a conversation or activity to inspect participants.</div>`;
  composerForm.classList.add("hidden");
}

function renderGantt(tasks) {
  if (!tasks.length) return `<div class="empty">No scheduled tasks yet.</div>`;
  const starts = tasks
    .map((t) => Date.parse(t.start_at))
    .filter((v) => Number.isFinite(v));
  const ends = tasks
    .map((t) => Date.parse(t.end_at))
    .filter((v) => Number.isFinite(v));
  const minStart = starts.length ? Math.min(...starts) : Date.now();
  const maxEnd = ends.length ? Math.max(...ends) : minStart + 86_400_000;
  const span = Math.max(1, maxEnd - minStart);

  return (
    `<section class="gantt-frame">` +
    tasks
      .map((t) => {
        const s = Number.isFinite(Date.parse(t.start_at)) ? Date.parse(t.start_at) : minStart;
        const e = Number.isFinite(Date.parse(t.end_at)) ? Date.parse(t.end_at) : s + 86_400_000;
        const left = Math.max(0, ((s - minStart) / span) * 100);
        const width = Math.max(2, ((Math.max(e, s + 1) - s) / span) * 100);
        return (
          `<div class="gantt-row">` +
          `<div class="gantt-label"><strong>${esc(t.title)}</strong><div class="meta">${esc(t.status)} · ${esc(String(t.progress_pct))}%</div></div>` +
          `<div class="gantt-track"><span class="gantt-bar ${t.critical ? "critical" : ""}" style="left:${left}%;width:${width}%"></span></div>` +
          `<div class="meta">${t.duration_days}d</div>` +
          `</div>`
        );
      })
      .join("") +
    `</section>`
  );
}

function renderRecommendations() {
  const rows = state.allocationRecommendations || [];
  if (!rows.length) return `<div class="empty">No allocation suggestions available.</div>`;
  return (
    `<div class="recommend-table">` +
    `<table><thead><tr><th>Task</th><th>Provider/Model</th><th>Agent</th><th>Tokens</th><th></th></tr></thead><tbody>` +
    rows
      .map(
        (r) =>
          `<tr>` +
          `<td>${esc(r.task_id)}</td>` +
          `<td>${esc(r.preferred_provider)}${r.preferred_model ? ` / ${esc(r.preferred_model)}` : ""}</td>` +
          `<td>${esc(resolveAgent(r.preferred_agent_id)?.name || r.preferred_agent_id || "unassigned")}</td>` +
          `<td>${esc(String(r.token_budget_hint ?? ""))}</td>` +
          `<td><button class="secondary-btn" data-apply-task-id="${esc(r.task_id)}" type="button">Apply</button></td>` +
          `</tr>`
      )
      .join("") +
    `</tbody></table>` +
    `</div>`
  );
}

function renderHomeView() {
  const pm = state.pmSnapshot;
  const resources = state.resourcesSnapshot;
  if (!pm) {
    contentBodyEl.innerHTML = `<div class="empty">No PM data available.</div>`;
    participantListEl.innerHTML = `<div class="empty">No participants.</div>`;
    composerForm.classList.add("hidden");
    return;
  }

  if (state.selectedRail.kind === "workspace") {
    viewTitleEl.textContent = "Workspace Home";
    viewSubtitleEl.textContent = "Portfolio progress, token burn, and project health";

    const s = pm.workspace.summary;
    const r = resources?.totals;
    const kpis = [
      ["Projects", s.project_count],
      ["Progress", `${s.progress_pct}%`],
      ["Blocked Projects", s.blocked_projects],
      ["Pending Reviews", s.pending_reviews],
      ["Active Runs", s.active_runs],
      ["Total Tokens", r?.total_tokens ?? 0],
      ["Cost USD", Number(r?.total_cost_usd || 0).toFixed(4)],
      ["Workers Active", r?.active_workers ?? 0]
    ];

    const tableRows = (pm.workspace.projects || [])
      .map(
        (p) =>
          `<tr>` +
          `<td>${esc(p.name)}</td>` +
          `<td>${esc(String(p.task_count))}</td>` +
          `<td><div class="progress"><span style="width:${Math.max(0, Math.min(100, p.progress_pct || 0))}%"></span></div></td>` +
          `<td>${esc(String(p.blocked_tasks))}</td>` +
          `<td>${esc(String(p.active_runs))}</td>` +
          `<td>${(p.risk_flags || []).length ? (p.risk_flags || []).map((f) => `<span class="risk">${esc(f)}</span>`).join(" ") : "-"}</td>` +
          `</tr>`
      )
      .join("");

    contentBodyEl.innerHTML =
      `<section class="pm-grid">` +
      kpis
        .map(
          ([k, v]) =>
            `<article class="pm-kpi"><div class="label">${esc(k)}</div><div class="value">${esc(String(v))}</div></article>`
        )
        .join("") +
      `</section>` +
      `<section class="pm-table"><table><thead><tr><th>Project</th><th>Tasks</th><th>Progress</th><th>Blocked</th><th>Runs</th><th>Risk</th></tr></thead><tbody>${tableRows || `<tr><td colspan="6">No projects yet.</td></tr>`}</tbody></table></section>`;

    participantListEl.innerHTML = (pm.workspace.projects || []).length
      ? pm.workspace.projects
          .slice(0, 20)
          .map(
            (p) =>
              `<article class="participant-item"><div>${esc(p.name)}</div><div class="meta">progress=${esc(String(p.progress_pct))}% · tasks=${esc(String(p.task_count))} · blocked=${esc(String(p.blocked_tasks))}</div></article>`
          )
          .join("")
      : `<div class="empty">No projects in workspace.</div>`;

    composerForm.classList.add("hidden");
    return;
  }

  const projectId = state.selectedRail.projectId;
  const project = state.projects.find((p) => p.project_id === projectId);
  viewTitleEl.textContent = `${project?.name || "Project"} Home`;
  viewSubtitleEl.textContent = "Task board, Gantt schedule, and model allocation controls";

  const ps = pm.project?.summary || {
    task_count: 0,
    done_tasks: 0,
    blocked_tasks: 0,
    in_progress_tasks: 0,
    progress_pct: 0
  };
  const rs = resources?.totals;
  const kpis = [
    ["Tasks", ps.task_count],
    ["Progress", `${ps.progress_pct}%`],
    ["In Progress", ps.in_progress_tasks],
    ["Blocked", ps.blocked_tasks],
    ["Tokens", rs?.total_tokens ?? 0],
    ["Cost USD", Number(rs?.total_cost_usd || 0).toFixed(4)],
    ["Cycles", rs?.context_cycles_total ?? 0],
    ["CPM", pm.project?.gantt?.cpm_status || "ok"]
  ];

  contentBodyEl.innerHTML =
    `<section class="pm-grid">` +
    kpis
      .map(
        ([k, v]) =>
          `<article class="pm-kpi"><div class="label">${esc(k)}</div><div class="value">${esc(String(v))}</div></article>`
      )
      .join("") +
    `</section>` +
    `<section class="gantt-card"><h3>Gantt / Critical Path</h3>${renderGantt(pm.project?.gantt?.tasks || [])}</section>` +
    `<section class="pm-card"><div style="display:flex;justify-content:space-between;align-items:center"><h3>Allocation Suggestions</h3><button class="primary-btn" id="applyAllAllocBtn" type="button">Apply All</button></div>${renderRecommendations()}</section>`;

  const applyAllBtn = document.getElementById("applyAllAllocBtn");
  if (applyAllBtn) {
    applyAllBtn.addEventListener("click", async () => {
      try {
        await applyAllocations(state.allocationRecommendations);
      } catch (e) {
        alert(`Failed to apply allocations: ${e.message || e}`);
      }
    });
  }

  Array.from(contentBodyEl.querySelectorAll("[data-apply-task-id]"))
    .forEach((btn) => {
      btn.addEventListener("click", async () => {
        const taskId = btn.getAttribute("data-apply-task-id");
        if (!taskId) return;
        const item = state.allocationRecommendations.find((r) => r.task_id === taskId);
        if (!item) return;
        try {
          await applyAllocations([item]);
        } catch (e) {
          alert(`Failed to apply allocation: ${e.message || e}`);
        }
      });
    });

  participantListEl.innerHTML = state.allocationRecommendations.length
    ? state.allocationRecommendations
        .slice(0, 40)
        .map((r) => {
          const agent = resolveAgent(r.preferred_agent_id);
          return `<button class="participant-item" data-agent-id="${esc(agent?.agent_id || "")}" type="button"><div>${esc(agent?.name || r.preferred_agent_id || "Unassigned")}</div><div class="meta">${esc(r.preferred_provider)}${r.preferred_model ? ` / ${esc(r.preferred_model)}` : ""} · tokens=${esc(String(r.token_budget_hint || 0))}</div></button>`;
        })
        .join("")
    : `<div class="empty">No recommendations yet.</div>`;

  Array.from(participantListEl.querySelectorAll("[data-agent-id]"))
    .forEach((btn) => {
      btn.addEventListener("click", async () => {
        const agentId = btn.getAttribute("data-agent-id");
        if (!agentId) return;
        await openProfile(agentId);
      });
    });

  composerForm.classList.add("hidden");
}

function renderCurrentView() {
  if (!state.workspaceDir) {
    viewTitleEl.textContent = "Workspace Not Connected";
    viewSubtitleEl.textContent = "Open Settings and provide a workspace directory.";
    contentBodyEl.innerHTML = `<div class="empty">Use ⚙ to configure workspace and actor.</div>`;
    participantListEl.innerHTML = `<div class="empty">No participants.</div>`;
    composerForm.classList.add("hidden");
    return;
  }

  if (state.selectedView.type === "home") {
    renderHomeView();
    return;
  }

  if (state.selectedView.type === "conversation") {
    renderMessageView();
    return;
  }

  if (state.selectedView.type === "activities") {
    renderActivitiesView();
    return;
  }

  renderResourcesView();
}

async function refreshAndRenderCurrentView() {
  try {
    await refreshCurrentViewData();
    renderSidebar();
    renderCurrentView();
    saveSession();
  } catch (e) {
    contentBodyEl.innerHTML = `<div class="empty">Failed to refresh view: ${esc(e.message || e)}</div>`;
  }
}

async function refreshAndRender() {
  if (!state.workspaceDir || state.refreshBusy) {
    renderProjectRail();
    renderSidebar();
    renderCurrentView();
    return;
  }
  state.refreshBusy = true;
  try {
    await refreshProjectsAgentsTeams();
    await refreshConversations();
    await refreshCurrentViewData();
  } catch (e) {
    setSettingsStatus(`Refresh failed: ${e.message || e}`);
  } finally {
    state.refreshBusy = false;
  }
  renderProjectRail();
  renderSidebar();
  renderCurrentView();
  saveSession();
}

async function applyAllocations(items) {
  if (!state.selectedRail.projectId) return;
  const payload = (items || []).map((i) => ({
    task_id: i.task_id,
    preferred_provider: i.preferred_provider,
    preferred_model: i.preferred_model,
    preferred_agent_id: i.preferred_agent_id,
    token_budget_hint: i.token_budget_hint
  }));
  if (!payload.length) return;
  await rpcCall("pm.apply_allocations", {
    workspace_dir: state.workspaceDir,
    project_id: state.selectedRail.projectId,
    applied_by: state.actorId,
    items: payload
  });
  await refreshAndRenderCurrentView();
}

async function openProfile(agentId) {
  state.profileAgentId = agentId;
  const profile = await rpcCall("agent.profile.snapshot", {
    workspace_dir: state.workspaceDir,
    agent_id: agentId,
    project_id: state.selectedRail.projectId ?? undefined
  });
  profileNameEl.textContent = profile.agent.name;
  const model = profile.agent.model_hint || `${profile.agent.provider} (default)`;
  profileMetaEl.textContent = `${profile.agent.role.toUpperCase()} · ${model} · tenure ${profile.agent.tenure_days} day(s)`;
  const stats = [
    ["Total Runs", profile.metrics.total_runs],
    ["Running", profile.metrics.running_runs],
    ["Ended", profile.metrics.ended_runs],
    ["Failed", profile.metrics.failed_runs],
    ["Tokens", profile.metrics.total_tokens],
    ["Cost USD", Number(profile.metrics.total_cost_usd || 0).toFixed(4)],
    ["Context Cycles", profile.metrics.context_cycles_count == null ? "unknown" : profile.metrics.context_cycles_count],
    ["Cycle Source", profile.metrics.context_cycles_source]
  ];
  profileStatsEl.innerHTML = stats
    .map(([k, v]) => `<article class="profile-stat"><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}</div></article>`)
    .join("");
  profileModal.showModal();
}

async function openLiveOps() {
  if (!state.workspaceDir) {
    alert("Set a workspace first.");
    return;
  }
  const projectId = state.selectedRail.projectId || state.projects[0]?.project_id || null;
  if (!projectId) {
    alert("Create or select a project first.");
    return;
  }
  const invoke = getInvoke();
  if (!invoke) return;
  const status = await invoke("start_manager_web", {
    args: {
      workspace_dir: state.workspaceDir,
      project_id: projectId,
      actor_id: state.actorId,
      actor_role: "ceo",
      sync_index: true
    }
  });
  liveOpsFrame.src = status.url || "about:blank";
  liveOpsModal.showModal();
}

function renderChannelParticipantsPicker() {
  channelParticipantList.innerHTML = state.agents
    .map((a) => {
      const checked = a.agent_id === state.actorId || a.agent_id === "human_ceo";
      return (
        `<label class="picker-option">` +
        `<input type="checkbox" data-participant-agent="${esc(a.agent_id)}" ${checked ? "checked" : ""} />` +
        `<span>${esc(a.name)}</span>` +
        `<span class="meta">${esc(a.role)} · ${esc(a.provider)}</span>` +
        `</label>`
      );
    })
    .join("");
}

function openChannelModal() {
  channelNameInput.value = "";
  channelVisibilitySelect.value = state.selectedRail.kind === "project" ? "team" : "managers";
  channelTeamSelect.innerHTML =
    `<option value="">No team binding</option>` +
    state.teams.map((t) => `<option value="${esc(t.team_id)}">${esc(t.name)}</option>`).join("");
  renderChannelParticipantsPicker();
  channelModal.showModal();
}

function dmCandidates(query) {
  const q = String(query || "").trim().toLowerCase();
  return state.agents
    .filter((a) => a.agent_id !== state.actorId && a.agent_id !== "human_ceo")
    .filter((a) => {
      if (!q) return true;
      return (`${a.name} ${a.role} ${a.provider} ${a.model_hint || ""}`.toLowerCase().includes(q));
    });
}

function renderDmPicker(query = "") {
  const options = dmCandidates(query);
  if (!options.length) {
    dmAgentList.innerHTML = `<div class="empty">No matching agents.</div>`;
    state.selectedDmPeerId = null;
    return;
  }
  if (!state.selectedDmPeerId || !options.some((a) => a.agent_id === state.selectedDmPeerId)) {
    state.selectedDmPeerId = options[0].agent_id;
  }

  dmAgentList.innerHTML = options
    .map(
      (a) =>
        `<label class="picker-option">` +
        `<input type="radio" name="dmPeer" value="${esc(a.agent_id)}" ${a.agent_id === state.selectedDmPeerId ? "checked" : ""} />` +
        `<span>${esc(a.name)}</span>` +
        `<span class="meta">${esc(a.role)} · ${esc(a.provider)}${a.model_hint ? ` · ${esc(a.model_hint)}` : ""}</span>` +
        `</label>`
    )
    .join("");

  Array.from(dmAgentList.querySelectorAll('input[name="dmPeer"]')).forEach((el) => {
    el.addEventListener("change", () => {
      state.selectedDmPeerId = el.value;
    });
  });
}

function openDmModal() {
  dmSearchInput.value = "";
  renderDmPicker("");
  dmModal.showModal();
}

function openOnboardModal() {
  onboardNameInput.value = "";
  onboardRoleSelect.value = "worker";
  onboardProviderSelect.value = "codex";
  onboardTeamSelect.innerHTML =
    `<option value="">No team</option>` +
    state.teams.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
  onboardModal.showModal();
}

async function handleProjectCreate(ev) {
  ev.preventDefault();
  const name = projectNameInput.value.trim();
  if (!name) return;
  const repoIds = parseRepoIds(projectReposInput.value);
  const created = await rpcCall("workspace.project.create_with_defaults", {
    workspace_dir: state.workspaceDir,
    name,
    ceo_actor_id: state.actorId,
    repo_ids: repoIds
  });
  projectModal.close();
  state.selectedRail = { kind: "project", projectId: created.project_id };
  state.selectedView = { type: "home", conversationId: null };
  projectNameInput.value = "";
  projectReposInput.value = "";
  await refreshAndRender();
}

async function handleChannelCreate(ev) {
  ev.preventDefault();
  const name = channelNameInput.value.trim();
  if (!name) return;
  const slug = slugify(name);
  if (!slug) return;
  const participantAgentIds = Array.from(channelParticipantList.querySelectorAll("[data-participant-agent]"))
    .filter((el) => el.checked)
    .map((el) => el.getAttribute("data-participant-agent"))
    .filter(Boolean);
  const teamId = channelTeamSelect.value.trim();

  const scope = scopeParams();
  const created = await rpcCall("conversation.create_channel", {
    workspace_dir: state.workspaceDir,
    ...scope,
    name,
    slug,
    visibility: channelVisibilitySelect.value,
    created_by: state.actorId,
    participant_agent_ids: [...new Set([state.actorId, ...participantAgentIds])],
    participant_team_ids: teamId ? [teamId] : []
  });

  channelModal.close();
  state.selectedView = { type: "conversation", conversationId: created.id };
  await refreshAndRender();
}

async function handleDmCreate(ev) {
  ev.preventDefault();
  if (!state.selectedDmPeerId) {
    alert("Select an agent for DM.");
    return;
  }
  const scope = scopeParams();
  const dm = await rpcCall("conversation.create_dm", {
    workspace_dir: state.workspaceDir,
    ...scope,
    created_by: state.actorId,
    peer_agent_id: state.selectedDmPeerId
  });
  dmModal.close();
  state.selectedView = { type: "conversation", conversationId: dm.id };
  await refreshAndRender();
}

async function handleBootstrap() {
  const invoke = getInvoke();
  if (!invoke) return;
  const workspaceDir = workspaceInput.value.trim();
  if (!workspaceDir) return;
  setSettingsStatus("Bootstrapping workspace presets...");
  const res = await invoke("bootstrap_workspace", {
    args: {
      workspace_dir: workspaceDir,
      company_name: "AgentCompany",
      project_name: "AgentCompany Ops",
      departments: ["engineering", "product", "operations"],
      include_ceo: true,
      include_director: true,
      force: false
    }
  });
  state.workspaceDir = workspaceDir;
  state.actorId = res?.agents?.ceo_agent_id || actorInput.value.trim() || "human_ceo";
  setSettingsStatus("Bootstrap complete.");
  await refreshAndRender();
}

async function handleOnboard(ev) {
  ev.preventDefault();
  const invoke = getInvoke();
  if (!invoke) return;
  const workspaceDir = state.workspaceDir || workspaceInput.value.trim();
  if (!workspaceDir) {
    setSettingsStatus("Set workspace directory first.");
    return;
  }
  const name = onboardNameInput.value.trim();
  if (!name) return;

  await invoke("onboard_agent", {
    args: {
      workspace_dir: workspaceDir,
      name,
      role: onboardRoleSelect.value,
      provider: onboardProviderSelect.value,
      team_name: onboardTeamSelect.value.trim() || undefined
    }
  });

  onboardModal.close();
  setSettingsStatus("Agent onboarded.");
  await refreshAndRender();
}

workspaceRailBtn.addEventListener("click", async () => {
  state.selectedRail = { kind: "workspace", projectId: null };
  state.selectedView = { type: "home", conversationId: null };
  await refreshAndRender();
});

homeViewBtn.addEventListener("click", async () => {
  state.selectedView = { type: "home", conversationId: null };
  await refreshAndRenderCurrentView();
});

activitiesViewBtn.addEventListener("click", async () => {
  state.selectedView = { type: "activities", conversationId: null };
  await refreshAndRenderCurrentView();
});

resourcesViewBtn.addEventListener("click", async () => {
  state.selectedView = { type: "resources", conversationId: null };
  await refreshAndRenderCurrentView();
});

projectAddBtn.addEventListener("click", () => {
  if (!state.workspaceDir) {
    settingsModal.showModal();
    return;
  }
  projectModal.showModal();
});

settingsBtn.addEventListener("click", () => {
  workspaceInput.value = state.workspaceDir;
  actorInput.value = state.actorId;
  settingsModal.showModal();
});

projectCancelBtn.addEventListener("click", () => projectModal.close());
channelCancelBtn.addEventListener("click", () => channelModal.close());
dmCancelBtn.addEventListener("click", () => dmModal.close());
settingsCancelBtn.addEventListener("click", () => settingsModal.close());
onboardCancelBtn.addEventListener("click", () => onboardModal.close());
profileCloseBtn.addEventListener("click", () => profileModal.close());
liveOpsCloseBtn.addEventListener("click", () => liveOpsModal.close());

addChannelBtn.addEventListener("click", () => {
  if (!state.workspaceDir) {
    settingsModal.showModal();
    return;
  }
  openChannelModal();
});

addDmBtn.addEventListener("click", () => {
  if (!state.workspaceDir) {
    settingsModal.showModal();
    return;
  }
  openDmModal();
});

dmSearchInput.addEventListener("input", () => renderDmPicker(dmSearchInput.value));

syncBtn.addEventListener("click", async () => {
  await refreshAndRender();
});

liveOpsBtn.addEventListener("click", async () => {
  try {
    await openLiveOps();
  } catch (e) {
    alert(`Failed to open Live Ops: ${e.message || e}`);
  }
});

projectForm.addEventListener("submit", async (ev) => {
  try {
    await handleProjectCreate(ev);
  } catch (e) {
    alert(`Project creation failed: ${e.message || e}`);
  }
});

channelForm.addEventListener("submit", async (ev) => {
  try {
    await handleChannelCreate(ev);
  } catch (e) {
    alert(`Failed to create channel: ${e.message || e}`);
  }
});

dmForm.addEventListener("submit", async (ev) => {
  try {
    await handleDmCreate(ev);
  } catch (e) {
    alert(`Failed to open DM: ${e.message || e}`);
  }
});

settingsForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  state.workspaceDir = workspaceInput.value.trim();
  state.actorId = actorInput.value.trim() || "human_ceo";
  settingsModal.close();
  await refreshAndRender();
});

bootstrapBtn.addEventListener("click", async () => {
  try {
    await handleBootstrap();
  } catch (e) {
    setSettingsStatus(`Bootstrap failed: ${e.message || e}`);
  }
});

openOnboardBtn.addEventListener("click", () => {
  openOnboardModal();
});

onboardForm.addEventListener("submit", async (ev) => {
  try {
    await handleOnboard(ev);
  } catch (e) {
    setSettingsStatus(`Onboard failed: ${e.message || e}`);
  }
});

composerForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = composerInput.value.trim();
  if (!body) return;
  if (state.selectedView.type !== "conversation" || !state.selectedView.conversationId) return;
  try {
    const params = scopeParams();
    await rpcCall("conversation.message.send", {
      workspace_dir: state.workspaceDir,
      conversation_id: state.selectedView.conversationId,
      author_id: state.actorId,
      author_role: "ceo",
      body,
      ...params
    });
    composerInput.value = "";
    await refreshAndRenderCurrentView();
  } catch (e) {
    alert(`Message send failed: ${e.message || e}`);
  }
});

composerInput.addEventListener("keydown", async (ev) => {
  if (ev.key !== "Enter" || ev.shiftKey) return;
  ev.preventDefault();
  composerForm.requestSubmit();
});

profileMessageBtn.addEventListener("click", async () => {
  if (!state.profileAgentId) return;
  try {
    const params = scopeParams();
    const dm = await rpcCall("conversation.create_dm", {
      workspace_dir: state.workspaceDir,
      created_by: state.actorId,
      peer_agent_id: state.profileAgentId,
      ...params
    });
    profileModal.close();
    state.selectedView = { type: "conversation", conversationId: dm.id };
    await refreshAndRender();
  } catch (e) {
    alert(`Failed to open DM: ${e.message || e}`);
  }
});

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (!state.workspaceDir || state.refreshBusy) return;
    void refreshAndRender();
  }, 15000);
}

loadSession();
workspaceInput.value = state.workspaceDir;
actorInput.value = state.actorId;
renderProjectRail();
renderSidebar();
renderCurrentView();
startPolling();
if (state.workspaceDir) {
  void refreshAndRender();
}
