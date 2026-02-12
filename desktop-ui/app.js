const STORAGE_KEY = "agentcompany.desktop.session.slack.v1";

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

const settingsModal = document.getElementById("settingsModal");
const settingsForm = document.getElementById("settingsForm");
const workspaceInput = document.getElementById("workspaceInput");
const actorInput = document.getElementById("actorInput");
const settingsStatus = document.getElementById("settingsStatus");
const bootstrapBtn = document.getElementById("bootstrapBtn");
const onboardBtn = document.getElementById("onboardBtn");
const settingsCancelBtn = document.getElementById("settingsCancelBtn");

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
    type: "conversation",
    conversationId: null
  },
  projects: [],
  agents: [],
  conversationsWorkspace: [],
  conversationsProject: [],
  messages: [],
  activitiesSnapshot: null,
  resourcesSnapshot: null,
  profileAgentId: null,
  refreshBusy: false,
  pollTimer: null
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

function saveSession() {
  const payload = {
    workspaceDir: state.workspaceDir,
    actorId: state.actorId,
    selectedRail: state.selectedRail,
    selectedView: state.selectedView
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
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
    if (parsed.selectedView?.type === "activities" || parsed.selectedView?.type === "resources") {
      state.selectedView = { type: parsed.selectedView.type, conversationId: null };
    } else if (parsed.selectedView?.conversationId) {
      state.selectedView = {
        type: "conversation",
        conversationId: String(parsed.selectedView.conversationId)
      };
    }
  } catch {
    // ignore malformed persisted session
  }
}

function setSettingsStatus(msg) {
  settingsStatus.textContent = msg || "";
}

function fmtDate(value) {
  if (!value) return "recent";
  const t = Date.parse(String(value));
  if (!Number.isFinite(t)) return "recent";
  return new Date(t).toLocaleString();
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function currentScopeParams() {
  if (state.selectedRail.kind === "project" && state.selectedRail.projectId) {
    return {
      scope: "project",
      project_id: state.selectedRail.projectId
    };
  }
  return { scope: "workspace" };
}

function getCurrentConversations() {
  return state.selectedRail.kind === "project" ? state.conversationsProject : state.conversationsWorkspace;
}

function getConversationById(id) {
  return getCurrentConversations().find((c) => c.id === id) || null;
}

function getHomeConversation() {
  return getCurrentConversations().find((c) => c.slug === "home") || null;
}

function resolveAgent(agentId) {
  if (agentId === state.actorId || agentId === "human_ceo") {
    return { agent_id: agentId, name: "You", role: "ceo", provider: "manual" };
  }
  return state.agents.find((a) => a.agent_id === agentId) || null;
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

async function refreshProjectsAndAgents() {
  const [projectsPayload, agents] = await Promise.all([
    rpcCall("workspace.projects.list", {
      workspace_dir: state.workspaceDir
    }),
    rpcCall("workspace.agents.list", {
      workspace_dir: state.workspaceDir
    })
  ]);
  state.projects = Array.isArray(projectsPayload?.projects) ? projectsPayload.projects : [];
  state.agents = Array.isArray(agents) ? agents : [];

  if (
    state.selectedRail.kind === "project" &&
    !state.projects.some((p) => p.project_id === state.selectedRail.projectId)
  ) {
    state.selectedRail = { kind: "workspace", projectId: null };
  }
  if (state.selectedRail.kind === "workspace" && !state.selectedRail.projectId && state.projects.length === 0) {
    state.selectedView = { type: "conversation", conversationId: null };
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

  const current = getCurrentConversations();
  const activeConversation = state.selectedView.conversationId
    ? current.find((c) => c.id === state.selectedView.conversationId)
    : null;
  if (state.selectedView.type === "conversation" && !activeConversation) {
    const home = getHomeConversation();
    state.selectedView = {
      type: "conversation",
      conversationId: home?.id ?? null
    };
  }
}

async function refreshCurrentViewData() {
  if (!state.workspaceDir) return;
  if (state.selectedView.type === "conversation" && state.selectedView.conversationId) {
    const scope = currentScopeParams();
    state.messages = await rpcCall("conversation.messages.list", {
      workspace_dir: state.workspaceDir,
      conversation_id: state.selectedView.conversationId,
      ...scope,
      limit: 300
    });
    state.activitiesSnapshot = null;
    state.resourcesSnapshot = null;
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
    state.resourcesSnapshot = null;
    state.messages = [];
    return;
  }
  if (state.selectedView.type === "resources") {
    state.resourcesSnapshot = await rpcCall("resources.snapshot", {
      workspace_dir: state.workspaceDir,
      project_id: state.selectedRail.projectId ?? undefined
    });
    state.activitiesSnapshot = null;
    state.messages = [];
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
      const home = state.conversationsProject.find((c) => c.slug === "home");
      state.selectedView = { type: "conversation", conversationId: home?.id ?? null };
      await refreshAndRender();
    });
  });
}

function renderSidebar() {
  const project =
    state.selectedRail.kind === "project"
      ? state.projects.find((p) => p.project_id === state.selectedRail.projectId)
      : null;

  scopeTitleEl.textContent = project ? project.name : "Workspace Home";
  scopeSubEl.textContent = project
    ? "Channels, DMs, activities, and resources"
    : "Global home with cross-project visibility";

  const conversations = getCurrentConversations();
  const home = conversations.find((c) => c.slug === "home") || null;
  homeViewBtn.classList.toggle("active", state.selectedView.type === "conversation" && state.selectedView.conversationId === home?.id);

  const channels = conversations.filter((c) => c.kind === "channel");
  channelListEl.innerHTML = channels.length
    ? channels
        .map((c) => {
          const active = state.selectedView.type === "conversation" && state.selectedView.conversationId === c.id;
          return `<button class="sidebar-item ${active ? "active" : ""}" data-conversation-id="${esc(c.id)}" type="button"># ${esc(c.slug)}</button>`;
        })
        .join("")
    : `<div class="empty">No channels yet.</div>`;

  const dms = conversations.filter((c) => c.kind === "dm");
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

function renderParticipants(conversation) {
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

function renderMessageView(conversation) {
  const titlePrefix = conversation.kind === "channel" ? "#" : conversation.kind === "dm" ? "@" : "";
  viewTitleEl.textContent = `${titlePrefix}${conversation.slug || conversation.name}`;
  viewSubtitleEl.textContent = conversation.kind === "dm"
    ? "Direct messages"
    : "Threaded operational messages and updates";

  if (!state.messages.length) {
    contentBodyEl.innerHTML = `<div class="empty">No messages yet. Start the thread.</div>`;
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
  renderParticipants(conversation);
}

function renderActivitiesView() {
  viewTitleEl.textContent = "Activities";
  viewSubtitleEl.textContent = "Approvals, run telemetry, and operational decisions";

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
  if (!items.length) {
    contentBodyEl.innerHTML = `<div class="empty">No activities yet.</div>`;
  } else {
    contentBodyEl.innerHTML = items
      .slice(0, 200)
      .map(
        (i) =>
          `<article class="activity-card"><div class="activity-meta"><span>${esc(i.title)}</span><span>${esc(fmtDate(i.ts))}</span></div><p class="activity-body">${esc(i.body)}</p></article>`
      )
      .join("");
  }
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
  viewSubtitleEl.textContent = "Token usage, workers, provider mix, and context-cycle telemetry";
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
  participantListEl.innerHTML = `<div class="empty">Select a channel or activity to inspect participants.</div>`;
  composerForm.classList.add("hidden");
}

function renderCurrentView() {
  if (!state.workspaceDir) {
    viewTitleEl.textContent = "Workspace Not Connected";
    viewSubtitleEl.textContent = "Open Settings and provide a workspace directory.";
    contentBodyEl.innerHTML = `<div class="empty">Use the ⚙ button to configure your workspace and actor.</div>`;
    participantListEl.innerHTML = `<div class="empty">No participants.</div>`;
    composerForm.classList.add("hidden");
    return;
  }

  if (state.selectedView.type === "activities") {
    renderActivitiesView();
    return;
  }
  if (state.selectedView.type === "resources") {
    renderResourcesView();
    return;
  }
  const conversation = getConversationById(state.selectedView.conversationId);
  if (!conversation) {
    contentBodyEl.innerHTML = `<div class="empty">Select a channel or DM.</div>`;
    participantListEl.innerHTML = `<div class="empty">No participants.</div>`;
    composerForm.classList.add("hidden");
    return;
  }
  renderMessageView(conversation);
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
    await refreshProjectsAndAgents();
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

async function openProfile(agentId) {
  state.profileAgentId = agentId;
  const profile = await rpcCall("agent.profile.snapshot", {
    workspace_dir: state.workspaceDir,
    agent_id: agentId,
    project_id: state.selectedRail.projectId ?? undefined
  });
  profileNameEl.textContent = profile.agent.name;
  const model = profile.agent.model_hint || `${profile.agent.provider} (default)`;
  profileMetaEl.textContent =
    `${profile.agent.role.toUpperCase()} · ${model} · tenure ${profile.agent.tenure_days} day(s)`;
  const stats = [
    ["Total Runs", profile.metrics.total_runs],
    ["Running", profile.metrics.running_runs],
    ["Ended", profile.metrics.ended_runs],
    ["Failed", profile.metrics.failed_runs],
    ["Tokens", profile.metrics.total_tokens],
    ["Cost USD", Number(profile.metrics.total_cost_usd || 0).toFixed(4)],
    [
      "Context Cycles",
      profile.metrics.context_cycles_count == null ? "unknown" : profile.metrics.context_cycles_count
    ],
    ["Cycle Source", profile.metrics.context_cycles_source]
  ];
  profileStatsEl.innerHTML = stats
    .map(
      ([k, v]) =>
        `<article class="profile-stat"><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}</div></article>`
    )
    .join("");
  profileModal.showModal();
}

function parseRepoIds(raw) {
  return String(raw || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
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
  state.selectedView = { type: "conversation", conversationId: null };
  projectNameInput.value = "";
  projectReposInput.value = "";
  await refreshAndRender();
}

async function handleCreateChannel() {
  if (!state.workspaceDir) return;
  const name = prompt("Channel name (e.g. Security):");
  if (!name || !name.trim()) return;
  const slug = slugify(name);
  if (!slug) return;
  const scope = currentScopeParams();
  const created = await rpcCall("conversation.create_channel", {
    workspace_dir: state.workspaceDir,
    ...scope,
    name: name.trim(),
    slug,
    visibility: state.selectedRail.kind === "project" ? "team" : "managers",
    created_by: state.actorId,
    participant_agent_ids: [state.actorId]
  });
  state.selectedView = { type: "conversation", conversationId: created.id };
  await refreshAndRender();
}

async function handleCreateDm() {
  if (!state.workspaceDir) return;
  const peers = state.agents.filter((a) => a.agent_id !== state.actorId && a.agent_id !== "human_ceo");
  if (!peers.length) {
    alert("No agents available for DM.");
    return;
  }
  const pickPrompt =
    "Enter an agent_id for DM:\n" +
    peers
      .slice(0, 40)
      .map((a) => `${a.agent_id} (${a.name}, ${a.role})`)
      .join("\n");
  const chosen = prompt(pickPrompt);
  if (!chosen) return;
  const peerId = chosen.trim();
  if (!peerId) return;
  const scope = currentScopeParams();
  const dm = await rpcCall("conversation.create_dm", {
    workspace_dir: state.workspaceDir,
    ...scope,
    created_by: state.actorId,
    peer_agent_id: peerId
  });
  state.selectedView = { type: "conversation", conversationId: dm.id };
  await refreshAndRender();
}

async function openLiveOps() {
  if (!state.workspaceDir) {
    alert("Set a workspace first.");
    return;
  }
  const projectId =
    state.selectedRail.projectId || state.projects[0]?.project_id || null;
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

async function handleOnboard() {
  const invoke = getInvoke();
  if (!invoke) return;
  const workspaceDir = workspaceInput.value.trim();
  if (!workspaceDir) return;
  const name = prompt("Worker name:", "New Worker");
  if (!name || !name.trim()) return;
  const teamName = prompt("Team name (optional):", "");
  setSettingsStatus("Onboarding agent...");
  await invoke("onboard_agent", {
    args: {
      workspace_dir: workspaceDir,
      name: name.trim(),
      role: "worker",
      provider: "codex",
      team_name: teamName?.trim() || undefined
    }
  });
  setSettingsStatus("Agent onboarded.");
  await refreshAndRender();
}

workspaceRailBtn.addEventListener("click", async () => {
  state.selectedRail = { kind: "workspace", projectId: null };
  state.selectedView = { type: "conversation", conversationId: null };
  await refreshAndRender();
});

homeViewBtn.addEventListener("click", async () => {
  const home = getHomeConversation();
  state.selectedView = { type: "conversation", conversationId: home?.id ?? null };
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
settingsCancelBtn.addEventListener("click", () => settingsModal.close());
profileCloseBtn.addEventListener("click", () => profileModal.close());
liveOpsCloseBtn.addEventListener("click", () => liveOpsModal.close());

addChannelBtn.addEventListener("click", async () => {
  try {
    await handleCreateChannel();
  } catch (e) {
    alert(`Failed to create channel: ${e.message || e}`);
  }
});

addDmBtn.addEventListener("click", async () => {
  try {
    await handleCreateDm();
  } catch (e) {
    alert(`Failed to create DM: ${e.message || e}`);
  }
});

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

onboardBtn.addEventListener("click", async () => {
  try {
    await handleOnboard();
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
    const scope = currentScopeParams();
    await rpcCall("conversation.message.send", {
      workspace_dir: state.workspaceDir,
      conversation_id: state.selectedView.conversationId,
      author_id: state.actorId,
      author_role: "ceo",
      body,
      ...scope
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
    const scope = currentScopeParams();
    const dm = await rpcCall("conversation.create_dm", {
      workspace_dir: state.workspaceDir,
      created_by: state.actorId,
      peer_agent_id: state.profileAgentId,
      ...scope
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
