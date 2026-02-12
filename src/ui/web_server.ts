import http from "node:http";
import path from "node:path";
import { buildUiSnapshot, type UiSnapshot } from "../runtime/ui_bundle.js";
import { buildRunMonitorSnapshot } from "../runtime/run_monitor.js";
import { buildReviewInboxSnapshot } from "../runtime/review_inbox.js";
import { buildUsageAnalyticsSnapshot } from "../runtime/usage_analytics.js";
import { resolveInboxAndBuildUiSnapshot } from "./resolve_and_snapshot.js";
import { subscribeRuntimeEvents } from "../runtime/event_bus.js";
import type { ActorRole } from "../policy/policy.js";
import { createComment, listComments } from "../comments/comment.js";
import { createIndexSyncWorker } from "../index/sync_worker.js";
import { syncSqliteIndex } from "../index/sqlite.js";
import { registerIndexSyncWorker } from "../runtime/index_sync_service.js";

export type UiWebServerArgs = {
  workspace_dir: string;
  project_id: string;
  actor_id: string;
  actor_role: ActorRole;
  actor_team_id?: string;
  host?: string;
  port?: number;
  monitor_limit?: number;
  pending_limit?: number;
  decisions_limit?: number;
  comments_limit?: number;
  refresh_index?: boolean;
  sync_index?: boolean;
};

export type UiWebServer = {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

type UiResolveBody = {
  artifact_id?: string;
  decision?: "approved" | "denied";
  notes?: string;
};

type UiCommentBody = {
  body?: string;
  target_agent_id?: string;
  target_artifact_id?: string;
  target_run_id?: string;
  visibility?: "private_agent" | "team" | "managers" | "org";
};

function projectFromEventsPath(eventsPath: string): string | undefined {
  const normalized = eventsPath.split(path.sep).join("/");
  const m = normalized.match(/\/work\/projects\/([^/]+)\/runs\/[^/]+\/events\.jsonl$/);
  return m?.[1];
}

function workspaceFromEventsPath(eventsPath: string): string | undefined {
  const normalized = eventsPath.split(path.sep).join("/");
  const m = normalized.match(/^(.*)\/work\/projects\/[^/]+\/runs\/[^/]+\/events\.jsonl$/);
  if (!m?.[1]) return undefined;
  const prefix = m[1];
  if (!prefix) return undefined;
  return eventsPath.includes(path.sep) ? prefix.split("/").join(path.sep) : prefix;
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

function sendHtml(res: http.ServerResponse, html: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}

function parseBooleanParam(v: string | null): boolean | undefined {
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes") return true;
  if (s === "0" || s === "false" || s === "no") return false;
  return undefined;
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += b.length;
    if (total > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(b);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function dashboardHtml(args: UiWebServerArgs): string {
  const init = JSON.stringify({
    project_id: args.project_id,
    actor_id: args.actor_id,
    actor_role: args.actor_role
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentCompany Manager Dashboard</title>
  <style>
    :root {
      --bg: #f5f7fb;
      --shell: #0f1726;
      --shell-accent: #1f2b43;
      --card: #ffffff;
      --ink: #1b2432;
      --muted: #5b6879;
      --line: #dbe2eb;
      --ok: #0f8a65;
      --bad: #b93f2e;
      --brand: #1f8cb8;
      --brand-soft: #e7f4fb;
      --mono: "IBM Plex Mono", "SF Mono", "Menlo", "Monaco", "Consolas", monospace;
      --sans: "IBM Plex Sans", "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: var(--sans);
      background:
        radial-gradient(1200px 420px at 30% -10%, #d9ecf8 0%, transparent 55%),
        radial-gradient(900px 360px at 80% -5%, #dce8ff 0%, transparent 52%),
        var(--bg);
    }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: 0;
    }
    .sidebar {
      background:
        linear-gradient(180deg, color-mix(in oklab, var(--shell), #000 8%) 0%, var(--shell) 100%);
      color: #dbe7f7;
      padding: 18px 14px;
      border-right: 1px solid #24324f;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .workspace-name {
      font-size: 17px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .workspace-sub {
      font-size: 12px;
      color: #a7bdd6;
      margin-top: -8px;
    }
    .sidebar-section {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #89a3c0;
      margin-top: 4px;
      margin-bottom: 2px;
    }
    .context-grid {
      display: grid;
      gap: 7px;
      font-size: 12px;
    }
    .context-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      color: #b8cae1;
    }
    .context-row strong {
      font-family: var(--mono);
      font-size: 11px;
      color: #f1f7ff;
      max-width: 160px;
      text-overflow: ellipsis;
      overflow: hidden;
      white-space: nowrap;
    }
    .channel-btn {
      width: 100%;
      border: 1px solid transparent;
      background: transparent;
      color: #c8d7ea;
      text-align: left;
      border-radius: 8px;
      padding: 8px 10px;
      font: inherit;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
    }
    .channel-btn:hover {
      background: color-mix(in oklab, var(--shell-accent), #fff 6%);
      color: #f5f9ff;
    }
    .channel-btn.active {
      background: color-mix(in oklab, var(--shell-accent), #fff 10%);
      border-color: color-mix(in oklab, var(--brand), #fff 20%);
      color: #f5f9ff;
    }
    .colleague-list {
      display: grid;
      gap: 2px;
    }
    .colleague-btn {
      width: 100%;
      border: 1px solid transparent;
      background: transparent;
      color: #c8d7ea;
      text-align: left;
      border-radius: 8px;
      padding: 7px 10px;
      font: inherit;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
    }
    .colleague-btn:hover {
      background: color-mix(in oklab, var(--shell-accent), #fff 6%);
      color: #f5f9ff;
    }
    .colleague-btn.active {
      background: color-mix(in oklab, var(--shell-accent), #fff 10%);
      border-color: color-mix(in oklab, var(--brand), #fff 20%);
      color: #f5f9ff;
    }
    .colleague-main {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      flex: none;
      background: #7389a7;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }
    .dot.active { background: #31c48d; }
    .dot.needs_review { background: #f6ad55; }
    .dot.idle { background: #7389a7; }
    .colleague-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .role-tag {
      display: inline-flex;
      margin-left: 6px;
      border: 1px solid #385170;
      border-radius: 999px;
      padding: 0 5px;
      font-size: 10px;
      color: #a7bdd6;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-family: var(--mono);
    }
    .count {
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 11px;
      color: #d0dff1;
      background: color-mix(in oklab, var(--shell-accent), #000 8%);
      font-family: var(--mono);
    }
    .sidebar-foot {
      margin-top: auto;
      border-top: 1px solid #24324f;
      padding-top: 12px;
      display: grid;
      gap: 8px;
    }
    .sync-state {
      font-size: 12px;
      color: #a7bdd6;
    }
    .sync-state.warn {
      color: #f6bf72;
    }
    .btn {
      border: 1px solid var(--line);
      background: var(--card);
      color: var(--ink);
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
    }
    .btn:hover { border-color: var(--brand); }
    .main {
      padding: 18px;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 12px;
      min-width: 0;
    }
    .top {
      background: rgba(255, 255, 255, 0.72);
      backdrop-filter: blur(6px);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px 16px;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .title {
      margin: 0;
      font-size: 22px;
      line-height: 1.1;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .meta {
      color: var(--muted);
      font-size: 13px;
      margin-top: 6px;
      font-family: var(--mono);
    }
    .chips {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .chip {
      background: var(--brand-soft);
      color: #13425d;
      border: 1px solid #bedef0;
      border-radius: 999px;
      font-size: 11px;
      padding: 3px 9px;
      font-family: var(--mono);
    }
    .pane {
      display: none;
      min-height: 0;
    }
    .pane.active { display: block; }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
      min-height: 0;
      height: 100%;
      display: flex;
      flex-direction: column;
    }
    .card h2 {
      margin: 0;
      padding: 12px 14px;
      font-size: 14px;
      background: #f8fbff;
      border-bottom: 1px solid var(--line);
      letter-spacing: 0.02em;
    }
    .card-body {
      overflow: auto;
      max-height: calc(100vh - 190px);
    }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      background: #fcfdff;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .act { display: flex; gap: 6px; }
    .btn-ok {
      border-color: #8cd7be;
      background: #e8f8f0;
      color: var(--ok);
    }
    .btn-bad {
      border-color: #efb2aa;
      background: #fff1ef;
      color: var(--bad);
    }
    .mono { font-family: var(--mono); }
    .pill {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--line);
      font-size: 11px;
      background: #f9fbfe;
    }
    .pane-note {
      margin: 0;
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
      background: #f9fcff;
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
    }
    .timeline {
      list-style: none;
      margin: 0;
      padding: 10px 12px 16px;
      display: grid;
      gap: 10px;
    }
    .msg {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #ffffff;
      padding: 8px 10px;
    }
    .msg-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 6px;
    }
    .msg-name {
      font-weight: 600;
      font-size: 12px;
    }
    .msg-time {
      color: var(--muted);
      font-size: 11px;
      font-family: var(--mono);
    }
    .msg-body {
      font-size: 12px;
      color: #253141;
      line-height: 1.45;
    }
    .msg-body .mono {
      font-size: 11px;
    }
    .err { color: var(--bad); margin: 0; min-height: 1.3em; font-size: 12px; }
    @media (max-width: 980px) {
      .shell {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr;
      }
      .sidebar {
        border-right: 0;
        border-bottom: 1px solid #24324f;
      }
      .main { padding: 12px; }
      .top { flex-direction: column; }
      .chips { justify-content: flex-start; }
      .card-body { max-height: 54vh; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="workspace-name">AgentCompany</div>
      <div class="workspace-sub">Manager Workspace</div>

      <div class="sidebar-section">Context</div>
      <div class="context-grid">
        <div class="context-row"><span>Project</span><strong id="navProject">-</strong></div>
        <div class="context-row"><span>Actor</span><strong id="navActor">-</strong></div>
        <div class="context-row"><span>Role</span><strong id="navRole">-</strong></div>
      </div>

      <div class="sidebar-section">Channels</div>
      <button class="channel-btn active" data-tab-target="pending" aria-selected="true">
        <span># pending-approvals</span><span class="count" id="summaryPending">0</span>
      </button>
      <button class="channel-btn" data-tab-target="runs" aria-selected="false">
        <span># run-monitor</span><span class="count" id="summaryRuns">0</span>
      </button>
      <button class="channel-btn" data-tab-target="decisions" aria-selected="false">
        <span># recent-decisions</span><span class="count" id="summaryDecisions">0</span>
      </button>

      <div class="sidebar-section">Colleagues</div>
      <div class="colleague-list" id="colleagueList"></div>

      <div class="sidebar-foot">
        <div id="syncState" class="sync-state"></div>
        <div id="parseState" class="sync-state"></div>
        <button id="refreshBtn" class="btn">Refresh</button>
      </div>
    </aside>

    <main class="main">
      <section class="top">
        <div>
          <h1 class="title">AgentCompany Manager Web</h1>
          <div id="meta" class="meta"></div>
        </div>
        <div class="chips">
          <span class="chip">Live Timeline</span>
          <span class="chip">Artifact Governance</span>
          <span class="chip">Local-First</span>
        </div>
      </section>

      <section class="pane active" data-pane="pending">
        <div class="card">
        <h2>Pending Approvals</h2>
          <div class="card-body">
          <table>
            <thead>
              <tr><th>Artifact</th><th>Type</th><th>Title</th><th>Run</th><th>Actions</th></tr>
            </thead>
            <tbody id="pendingBody"></tbody>
          </table>
          </div>
        </div>
      </section>

      <section class="pane" data-pane="runs">
        <div class="card">
          <h2>Run Monitor</h2>
          <div class="card-body">
          <table>
            <thead>
              <tr><th>Run</th><th>Status</th><th>Live</th><th>Last Event</th><th>Parse Errors</th><th>Governance</th></tr>
            </thead>
            <tbody id="runsBody"></tbody>
          </table>
          </div>
        </div>
      </section>

      <section class="pane" data-pane="decisions">
        <div class="card">
          <h2>Recent Decisions</h2>
          <div class="card-body">
          <table>
            <thead>
              <tr><th>Decision</th><th>Artifact</th><th>Actor</th><th>When</th></tr>
            </thead>
            <tbody id="decisionsBody"></tbody>
          </table>
          </div>
        </div>
      </section>

      <section class="pane" data-pane="colleague">
        <div class="card">
          <h2 id="colleagueTitle">Colleague Thread</h2>
          <p class="pane-note" id="colleagueMeta">Select a colleague from the sidebar.</p>
          <div class="pane-note" style="display:grid;gap:8px;">
            <label style="display:grid;gap:4px;font-size:11px;color:#54657a;">
              Artifact ID (optional)
              <input id="commentArtifactInput" type="text" placeholder="art_..." style="border:1px solid var(--line);border-radius:8px;padding:7px 9px;font:inherit;" />
            </label>
            <label style="display:grid;gap:4px;font-size:11px;color:#54657a;">
              Run ID (optional)
              <input id="commentRunInput" type="text" placeholder="run_..." style="border:1px solid var(--line);border-radius:8px;padding:7px 9px;font:inherit;" />
            </label>
            <label style="display:grid;gap:4px;font-size:11px;color:#54657a;">
              Reply
              <textarea id="commentBodyInput" rows="2" placeholder="Leave a note for this colleague..." style="border:1px solid var(--line);border-radius:8px;padding:8px 9px;font:inherit;resize:vertical;"></textarea>
            </label>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <span id="commentState" style="font-size:11px;color:#62778f;"></span>
              <button id="commentSendBtn" class="btn">Send Note</button>
            </div>
          </div>
          <div class="card-body">
            <ul class="timeline" id="colleagueTimeline"></ul>
          </div>
        </div>
      </section>

      <p id="error" class="err"></p>
    </main>
  </div>

  <script>
    const INIT = ${init};

    const metaEl = document.getElementById('meta');
    const syncEl = document.getElementById('syncState');
    const parseEl = document.getElementById('parseState');
    const errorEl = document.getElementById('error');
    const navProject = document.getElementById('navProject');
    const navActor = document.getElementById('navActor');
    const navRole = document.getElementById('navRole');
    const summaryPending = document.getElementById('summaryPending');
    const summaryRuns = document.getElementById('summaryRuns');
    const summaryDecisions = document.getElementById('summaryDecisions');
    const colleagueList = document.getElementById('colleagueList');
    const colleagueTitle = document.getElementById('colleagueTitle');
    const colleagueMeta = document.getElementById('colleagueMeta');
    const colleagueTimeline = document.getElementById('colleagueTimeline');
    const commentArtifactInput = document.getElementById('commentArtifactInput');
    const commentRunInput = document.getElementById('commentRunInput');
    const commentBodyInput = document.getElementById('commentBodyInput');
    const commentSendBtn = document.getElementById('commentSendBtn');
    const commentState = document.getElementById('commentState');
    const pendingBody = document.getElementById('pendingBody');
    const decisionsBody = document.getElementById('decisionsBody');
    const runsBody = document.getElementById('runsBody');
    const refreshBtn = document.getElementById('refreshBtn');
    const tabButtons = Array.from(document.querySelectorAll('[data-tab-target]'));
    const panes = Array.from(document.querySelectorAll('[data-pane]'));

    let state = null;
    let selectedColleagueId = null;
    let commentsRequestSeq = 0;
    let thinPollTick = 0;
    const threadCommentsByAgent = new Map();

    function esc(v) {
      return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    }

    function setError(msg) {
      errorEl.textContent = msg ? String(msg) : '';
    }

    function setCommentState(msg, isError = false) {
      commentState.textContent = msg ? String(msg) : '';
      commentState.style.color = isError ? 'var(--bad)' : '#62778f';
    }

    function fmtTs(ts) {
      if (!ts) return '-';
      try {
        return new Date(ts).toLocaleString();
      } catch {
        return String(ts);
      }
    }

    function roleLabel(role) {
      return String(role || 'agent').toUpperCase();
    }

    function currentCommentFilters() {
      return {
        artifact_id: commentArtifactInput.value.trim(),
        run_id: commentRunInput.value.trim()
      };
    }

    async function fetchThreadComments(agentId) {
      if (!agentId) return [];
      const params = new URLSearchParams();
      params.set('target_agent_id', agentId);
      params.set('limit', '400');
      const filters = currentCommentFilters();
      if (filters.artifact_id) params.set('target_artifact_id', filters.artifact_id);
      if (filters.run_id) params.set('target_run_id', filters.run_id);

      const seq = ++commentsRequestSeq;
      const res = await fetch('/api/comments?' + params.toString(), { method: 'GET' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body && body.error ? body.error : 'comments failed: ' + res.status);
      }
      if (seq !== commentsRequestSeq) {
        return threadCommentsByAgent.get(agentId) || [];
      }
      const comments = Array.isArray(body.comments) ? body.comments : [];
      threadCommentsByAgent.set(agentId, comments);
      return comments;
    }

    async function refreshThreadComments(agentId) {
      if (!agentId) return;
      try {
        await fetchThreadComments(agentId);
        if (state && selectedColleagueId === agentId) {
          renderColleagueThread(state, agentId);
        }
      } catch (e) {
        setCommentState(e instanceof Error ? e.message : String(e), true);
      }
    }

    function activatePane(target) {
      panes.forEach((pane) => {
        pane.classList.toggle('active', pane.getAttribute('data-pane') === target);
      });
      tabButtons.forEach((btn) => {
        const active = btn.getAttribute('data-tab-target') === target;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }

    function setActiveColleagueNav(agentId, clearChannels = false) {
      const buttons = Array.from(colleagueList.querySelectorAll('[data-colleague-id]'));
      buttons.forEach((btn) => {
        const active = btn.getAttribute('data-colleague-id') === agentId;
        btn.classList.toggle('active', active);
      });
      if (clearChannels) {
        tabButtons.forEach((btn) => {
          btn.classList.remove('active');
          btn.setAttribute('aria-selected', 'false');
        });
      }
    }

    function renderColleagueThread(snapshot, agentId) {
      const colleague = (snapshot.colleagues || []).find((c) => c.agent_id === agentId);
      if (!colleague) {
        colleagueTitle.textContent = 'Colleague Thread';
        colleagueMeta.textContent = 'Select a colleague from the sidebar.';
        commentArtifactInput.value = '';
        commentRunInput.value = '';
        commentBodyInput.value = '';
        commentBodyInput.disabled = true;
        commentSendBtn.disabled = true;
        setCommentState('');
        colleagueTimeline.innerHTML = '';
        return;
      }

      commentBodyInput.disabled = false;
      commentSendBtn.disabled = false;

      colleagueTitle.textContent = '@' + colleague.name;
      const teamText = colleague.team_name ? ('team=' + colleague.team_name) : 'team=unassigned';
      colleagueMeta.textContent =
        'role=' + colleague.role + ' · provider=' + colleague.provider + ' · ' + teamText + ' · status=' + colleague.status;

      const runItems = (snapshot.monitor.rows || [])
        .filter((r) => r.agent_id === agentId)
        .map((r) => ({
          ts: r.last_event?.ts_wallclock || r.created_at || '',
          who: colleague.name,
          body:
            'Run ' +
            '<span class=\"mono\">' + esc(r.run_id) + '</span>' +
            ' is ' + esc(r.live_status || r.run_status || 'unknown') +
            (r.last_event ? (' · last event ' + esc(r.last_event.type)) : '')
        }));

      const pendingItems = (snapshot.review_inbox.pending || [])
        .filter((p) => p.produced_by === agentId)
        .map((p) => ({
          ts: p.created_at || '',
          who: colleague.name,
          body:
            'Submitted ' + esc(p.artifact_type) +
            ' <span class=\"mono\">' + esc(p.artifact_id) + '</span>' +
            ' awaiting manager review.'
        }));

      const decisionItems = (snapshot.review_inbox.recent_decisions || [])
        .filter((d) => d.actor_id === agentId)
        .map((d) => ({
          ts: d.created_at || '',
          who: colleague.name,
          body:
            'Recorded decision <span class=\"mono\">' + esc(d.decision) +
            '</span> for artifact <span class=\"mono\">' + esc(d.subject_artifact_id) + '</span>.'
        }));

      const seededComments = threadCommentsByAgent.get(agentId) ||
        (snapshot.comments || []).filter((c) => c.target && c.target.agent_id === agentId);
      const filters = currentCommentFilters();
      const commentItems = seededComments
        .filter((c) => {
          if (filters.artifact_id && c.target?.artifact_id !== filters.artifact_id) return false;
          if (filters.run_id && c.target?.run_id !== filters.run_id) return false;
          return true;
        })
        .map((c) => {
          const artifactNote = c.target.artifact_id
            ? ' on artifact <span class=\"mono\">' + esc(c.target.artifact_id) + '</span>'
            : '';
          const runNote = c.target.run_id
            ? ' for run <span class=\"mono\">' + esc(c.target.run_id) + '</span>'
            : '';
          const escapedBody = esc(c.body).replace(/\\n/g, '<br>');
          return {
            ts: c.created_at || '',
            who: c.author_id === INIT.actor_id ? 'You' : c.author_id,
            body:
              'Commented' + artifactNote + runNote +
              ': ' + escapedBody
          };
        });

      const items = [...runItems, ...pendingItems, ...decisionItems, ...commentItems]
        .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
        .reverse();

      const latestPendingArtifact = (snapshot.review_inbox.pending || [])
        .find((p) => p.produced_by === agentId)?.artifact_id;
      if (!commentArtifactInput.value.trim() && latestPendingArtifact) {
        commentArtifactInput.value = latestPendingArtifact;
      }

      if (items.length === 0) {
        colleagueTimeline.innerHTML =
          '<li class=\"msg\"><div class=\"msg-head\"><span class=\"msg-name\">' + esc(colleague.name) +
          '</span><span class=\"msg-time\">now</span></div><div class=\"msg-body\">No recent activity for this colleague in the selected project.</div></li>';
        return;
      }

      colleagueTimeline.innerHTML = items.map((item) => {
        return '<li class=\"msg\">' +
          '<div class=\"msg-head\">' +
          '<span class=\"msg-name\">' + esc(item.who) + '</span>' +
          '<span class=\"msg-time\">' + esc(fmtTs(item.ts)) + '</span>' +
          '</div>' +
          '<div class=\"msg-body\">' + item.body + '</div>' +
          '</li>';
      }).join('');
    }

    function renderColleagues(snapshot) {
      const colleagues = snapshot.colleagues || [];
      if (!colleagues.length) {
        colleagueList.innerHTML = '<div class=\"pane-note\" style=\"border:0;background:transparent;padding:6px 2px;color:#9cb2cc;\">No agents found.</div>';
        selectedColleagueId = null;
        renderColleagueThread(snapshot, null);
        return;
      }

      const known = colleagues.some((c) => c.agent_id === selectedColleagueId);
      if (!known) selectedColleagueId = colleagues[0].agent_id;

      colleagueList.innerHTML = colleagues.map((c) => {
        const badge = c.pending_reviews > 0 ? c.pending_reviews : c.active_runs;
        return '<button class=\"colleague-btn\" data-colleague-id=\"' + esc(c.agent_id) + '\">' +
          '<span class=\"colleague-main\">' +
          '<span class=\"dot ' + esc(c.status) + '\"></span>' +
          '<span class=\"colleague-name\">@' + esc(c.name) + '<span class=\"role-tag\">' + esc(roleLabel(c.role)) + '</span></span>' +
          '</span>' +
          '<span class=\"count\">' + esc(String(badge || 0)) + '</span>' +
          '</button>';
      }).join('');

      Array.from(colleagueList.querySelectorAll('[data-colleague-id]')).forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-colleague-id');
          if (!id) return;
          selectedColleagueId = id;
          setActiveColleagueNav(id, true);
          activatePane('colleague');
          renderColleagueThread(snapshot, id);
          void refreshThreadComments(id);
        });
      });

      setActiveColleagueNav(selectedColleagueId);
      if (panes.some((p) => p.classList.contains('active') && p.getAttribute('data-pane') === 'colleague')) {
        renderColleagueThread(snapshot, selectedColleagueId);
      }
    }

    function render(snapshot) {
      state = snapshot;
      navProject.textContent = INIT.project_id;
      navActor.textContent = INIT.actor_id;
      navRole.textContent = INIT.actor_role;
      metaEl.textContent = 'updated ' + snapshot.generated_at + ' · replayable event log';
      syncEl.textContent = 'sync: ' + (snapshot.index_sync_worker.enabled ? 'on' : 'off') + ', pending=' + snapshot.index_sync_worker.pending_workspaces;
      const parseSummary = snapshot.review_inbox.parse_errors || {
        has_parse_errors: false,
        pending_with_errors: 0,
        decisions_with_errors: 0,
        max_parse_error_count: 0
      };
      parseEl.textContent = parseSummary.has_parse_errors
        ? 'parse alerts: pending=' + parseSummary.pending_with_errors + ', decisions=' + parseSummary.decisions_with_errors + ', max=' + parseSummary.max_parse_error_count
        : 'parse alerts: none';
      parseEl.classList.toggle('warn', !!parseSummary.has_parse_errors);

      const pending = snapshot.review_inbox.pending || [];
      summaryPending.textContent = String(pending.length);
      pendingBody.innerHTML = pending.map((p) => {
        return '<tr>' +
          '<td class="mono">' + esc(p.artifact_id) + '</td>' +
          '<td><span class="pill">' + esc(p.artifact_type) + '</span></td>' +
          '<td>' + esc(p.title || '-') + '</td>' +
          '<td class="mono">' + esc(p.run_id || '-') + '</td>' +
          '<td><div class="act">' +
            '<button class="btn btn-ok" data-action="approve" data-artifact="' + esc(p.artifact_id) + '">Approve</button>' +
            '<button class="btn btn-bad" data-action="deny" data-artifact="' + esc(p.artifact_id) + '">Deny</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');

      const decisions = snapshot.review_inbox.recent_decisions || [];
      summaryDecisions.textContent = String(decisions.length);
      decisionsBody.innerHTML = decisions.map((d) => {
        return '<tr>' +
          '<td>' + esc(d.decision) + '</td>' +
          '<td class="mono">' + esc(d.subject_artifact_id) + '</td>' +
          '<td class="mono">' + esc(d.actor_id) + '</td>' +
          '<td>' + esc(d.created_at) + '</td>' +
        '</tr>';
      }).join('');

      const runs = snapshot.monitor.rows || [];
      summaryRuns.textContent = String(runs.length);
      runsBody.innerHTML = runs.map((r) => {
        const policyDenied = r.latest_policy_denied;
        const policyDecision = r.latest_policy_decision;
        const budgetDecision = r.latest_budget_decision;
        const policyExplain = policyDenied
          ? 'deny ' + esc(String(policyDenied.rule_id || '?')) + '/' + esc(String(policyDenied.reason || '?'))
          : policyDecision
            ? (String(policyDecision.allowed) === 'false' ? 'deny' : 'allow') + ' ' +
              esc(String(policyDecision.rule_id || '?')) + '/' + esc(String(policyDecision.reason || '?'))
            : 'n/a';
        const budgetExplain = budgetDecision
          ? esc(String(budgetDecision.scope || '?')) + ':' +
            esc(String(budgetDecision.metric || '?')) + ':' +
            esc(String(budgetDecision.severity || '?')) + '=' +
            esc(String(budgetDecision.result || '?'))
          : 'n/a';
        const governance =
          'policy denied ' + esc(String(r.policy_denied_count || 0)) +
          '/' + esc(String(r.policy_decision_count || 0)) +
          ' · budget hard ' + esc(String(r.budget_exceeded_count || 0)) +
          ', soft ' + esc(String(r.budget_alert_count || 0)) +
          ' (' + esc(String(r.budget_decision_count || 0)) + ' decisions)' +
          '<br><span class="mono">policy: ' + policyExplain +
          ' · budget: ' + budgetExplain + '</span>';
        return '<tr>' +
          '<td class="mono">' + esc(r.run_id) + '</td>' +
          '<td>' + esc(r.run_status) + '</td>' +
          '<td>' + esc(r.live_status || '-') + '</td>' +
          '<td>' + esc(r.last_event ? r.last_event.type : '-') + '</td>' +
          '<td>' + esc(r.parse_error_count) + '</td>' +
          '<td>' + governance + '</td>' +
        '</tr>';
      }).join('');

      renderColleagues(snapshot);
      if (selectedColleagueId && panes.some((p) => p.classList.contains('active') && p.getAttribute('data-pane') === 'colleague')) {
        renderColleagueThread(snapshot, selectedColleagueId);
        void refreshThreadComments(selectedColleagueId);
      }
    }

    async function fetchFullSnapshot() {
      const res = await fetch('/api/ui/snapshot', { method: 'GET' });
      if (!res.ok) throw new Error('snapshot failed: ' + res.status);
      return await res.json();
    }

    async function fetchMonitorSnapshot() {
      const res = await fetch('/api/monitor/snapshot', { method: 'GET' });
      if (!res.ok) throw new Error('monitor snapshot failed: ' + res.status);
      return await res.json();
    }

    async function fetchInboxSnapshot() {
      const res = await fetch('/api/inbox/snapshot', { method: 'GET' });
      if (!res.ok) throw new Error('inbox snapshot failed: ' + res.status);
      return await res.json();
    }

    function mergeThinSnapshot(monitor, inbox, full) {
      return {
        workspace_dir: full?.workspace_dir || state?.workspace_dir || '',
        generated_at: full?.generated_at || new Date().toISOString(),
        index_sync_worker: full?.index_sync_worker || state?.index_sync_worker || {
          enabled: false,
          pending_workspaces: 0
        },
        monitor,
        review_inbox: inbox,
        colleagues: full?.colleagues || state?.colleagues || [],
        comments: full?.comments || state?.comments || []
      };
    }

    async function fetchSnapshot(options = {}) {
      const includeColleagues = options.includeColleagues === true;
      const [monitor, inbox, full] = await Promise.all([
        fetchMonitorSnapshot(),
        fetchInboxSnapshot(),
        includeColleagues ? fetchFullSnapshot() : Promise.resolve(null)
      ]);
      const merged = mergeThinSnapshot(monitor, inbox, full);
      render(merged);
      setError('');
      return merged;
    }

    async function resolve(decision, artifactId) {
      const notes = window.prompt('Optional notes', '') || '';
      const res = await fetch('/api/ui/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ artifact_id: artifactId, decision, notes })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body && body.error ? body.error : 'resolve failed: ' + res.status);
      }
      render(body.snapshot);
      setError('');
    }

    async function sendComment() {
      if (!selectedColleagueId) {
        setCommentState('Select a colleague first.', true);
        return;
      }
      const bodyText = commentBodyInput.value.trim();
      if (!bodyText) {
        setCommentState('Reply text is required.', true);
        return;
      }
      const artifactId = commentArtifactInput.value.trim();
      const runId = commentRunInput.value.trim();
      setCommentState('Sending...');
      commentSendBtn.setAttribute('disabled', 'true');
      try {
        const res = await fetch('/api/comments', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            target_agent_id: selectedColleagueId,
            target_artifact_id: artifactId || undefined,
            target_run_id: runId || undefined,
            body: bodyText
          })
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(payload && payload.error ? payload.error : 'comment failed: ' + res.status);
        }
        commentBodyInput.value = '';
        setCommentState('Note sent.');
        if (payload.snapshot) {
          render(payload.snapshot);
          activatePane('colleague');
          renderColleagueThread(payload.snapshot, selectedColleagueId);
          setActiveColleagueNav(selectedColleagueId, true);
        }
        await refreshThreadComments(selectedColleagueId);
      } catch (e) {
        setCommentState(e instanceof Error ? e.message : String(e), true);
      } finally {
        commentSendBtn.removeAttribute('disabled');
      }
    }

    pendingBody.addEventListener('click', async (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-action');
      const artifact = target.getAttribute('data-artifact');
      if (!action || !artifact) return;
      target.setAttribute('disabled', 'true');
      try {
        await resolve(action === 'approve' ? 'approved' : 'denied', artifact);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        target.removeAttribute('disabled');
      }
    });

    tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-tab-target');
        if (!target) return;
        setActiveColleagueNav(null);
        activatePane(target);
      });
    });

    commentSendBtn.addEventListener('click', () => {
      void sendComment();
    });

    commentBodyInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        void sendComment();
      }
    });

    const refreshThreadFromFilterChange = () => {
      if (!selectedColleagueId || !state) return;
      renderColleagueThread(state, selectedColleagueId);
      void refreshThreadComments(selectedColleagueId);
    };
    commentArtifactInput.addEventListener('change', refreshThreadFromFilterChange);
    commentRunInput.addEventListener('change', refreshThreadFromFilterChange);

    function applyExternalSelection(message) {
      if (!message || typeof message !== 'object') return;
      const pane = typeof message.pane === 'string' ? message.pane : '';
      const colleagueId = typeof message.colleague_id === 'string' ? message.colleague_id : null;
      if (pane === 'colleague' && colleagueId) {
        selectedColleagueId = colleagueId;
        setActiveColleagueNav(colleagueId, true);
        activatePane('colleague');
        if (state) {
          renderColleagueThread(state, colleagueId);
          void refreshThreadComments(colleagueId);
        }
        return;
      }
      if (pane === 'pending' || pane === 'runs' || pane === 'decisions') {
        setActiveColleagueNav(null);
        activatePane(pane);
      }
    }

    window.addEventListener('message', (evt) => {
      const data = evt.data;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'agentcompany.select') return;
      applyExternalSelection(data);
    });

    refreshBtn.addEventListener('click', async () => {
      try {
        thinPollTick = 0;
        await fetchSnapshot({ includeColleagues: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });

    function setupSse() {
      const es = new EventSource('/api/events');
      es.addEventListener('snapshot', (evt) => {
        try {
          const data = JSON.parse(evt.data);
          render(data);
          setError('');
        } catch {
          // ignore malformed events
        }
      });
      es.addEventListener('error', () => {
        setError('SSE disconnected, using polling fallback');
      });
      return es;
    }

    (async () => {
      commentBodyInput.disabled = true;
      commentSendBtn.disabled = true;

      const pageUrl = new URL(window.location.href);
      const initialPane = pageUrl.searchParams.get('pane');
      const initialColleagueId = pageUrl.searchParams.get('colleague_id');
      if (initialPane === 'runs' || initialPane === 'decisions') {
        activatePane(initialPane);
      } else if (initialPane === 'colleague' && initialColleagueId) {
        selectedColleagueId = initialColleagueId;
        activatePane('colleague');
      } else {
        activatePane('pending');
      }

      let es = null;
      try {
        await fetchSnapshot({ includeColleagues: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }

      if (selectedColleagueId && state) {
        setActiveColleagueNav(selectedColleagueId, true);
        renderColleagueThread(state, selectedColleagueId);
        void refreshThreadComments(selectedColleagueId);
      }

      try {
        es = setupSse();
      } catch {
        // ignore
      }

      setInterval(async () => {
        if (es && es.readyState === 1) return;
        try {
          thinPollTick += 1;
          const hasColleagues = Array.isArray(state?.colleagues) && state.colleagues.length > 0;
          const viewingColleague = panes.some(
            (p) => p.classList.contains('active') && p.getAttribute('data-pane') === 'colleague'
          );
          const includeColleagues =
            viewingColleague || !hasColleagues || thinPollTick % 6 === 0;
          await fetchSnapshot({ includeColleagues });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }, 5000);
    })();
  </script>
</body>
</html>`;
}

async function readSnapshot(args: UiWebServerArgs): Promise<UiSnapshot> {
  return buildUiSnapshot({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    monitor_limit: args.monitor_limit,
    pending_limit: args.pending_limit,
    decisions_limit: args.decisions_limit,
    comments_limit: args.comments_limit,
    refresh_index: args.refresh_index,
    sync_index: args.sync_index
  });
}

async function readMonitorSnapshot(
  args: UiWebServerArgs,
  overrides?: { refresh_index?: boolean; sync_index?: boolean }
): Promise<Awaited<ReturnType<typeof buildRunMonitorSnapshot>>> {
  return buildRunMonitorSnapshot({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    limit: args.monitor_limit,
    refresh_index: overrides?.refresh_index ?? args.refresh_index,
    sync_index: overrides?.sync_index ?? args.sync_index
  });
}

async function readInboxSnapshot(
  args: UiWebServerArgs,
  overrides?: { refresh_index?: boolean; sync_index?: boolean }
): Promise<Awaited<ReturnType<typeof buildReviewInboxSnapshot>>> {
  return buildReviewInboxSnapshot({
    workspace_dir: args.workspace_dir,
    project_id: args.project_id,
    pending_limit: args.pending_limit,
    decisions_limit: args.decisions_limit,
    refresh_index: overrides?.refresh_index ?? args.refresh_index,
    sync_index: overrides?.sync_index ?? args.sync_index
  });
}

export async function startUiWebServer(args: UiWebServerArgs): Promise<UiWebServer> {
  const host = args.host?.trim() || "127.0.0.1";
  const port = Number.isInteger(args.port) ? Number(args.port) : 8787;
  const worker = createIndexSyncWorker({
    debounce_ms: 250,
    min_interval_ms: 1000,
    sync: async (workspaceDir: string) => {
      await syncSqliteIndex(workspaceDir);
    }
  });
  registerIndexSyncWorker(worker);
  worker.notify(args.workspace_dir);
  const unsubWorker = subscribeRuntimeEvents((msg) => {
    const workspaceDir = workspaceFromEventsPath(msg.events_file_path);
    if (workspaceDir !== args.workspace_dir) return;
    worker.notify(workspaceDir);
  });

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    try {
      if (method === "GET" && url.pathname === "/") {
        sendHtml(res, dashboardHtml(args));
        return;
      }

      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          project_id: args.project_id,
          actor_id: args.actor_id,
          actor_role: args.actor_role,
          now: new Date().toISOString()
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/ui/snapshot") {
        const refreshParam = parseBooleanParam(url.searchParams.get("refresh_index"));
        const syncParam = parseBooleanParam(url.searchParams.get("sync_index"));
        const snap = await buildUiSnapshot({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          monitor_limit: args.monitor_limit,
          pending_limit: args.pending_limit,
          decisions_limit: args.decisions_limit,
          comments_limit: args.comments_limit,
          refresh_index: refreshParam ?? args.refresh_index,
          sync_index: syncParam ?? args.sync_index
        });
        sendJson(res, 200, snap);
        return;
      }

      if (method === "GET" && url.pathname === "/api/monitor/snapshot") {
        const refreshParam = parseBooleanParam(url.searchParams.get("refresh_index"));
        const syncParam = parseBooleanParam(url.searchParams.get("sync_index"));
        const monitor = await readMonitorSnapshot(args, {
          refresh_index: refreshParam,
          sync_index: syncParam
        });
        sendJson(res, 200, monitor);
        return;
      }

      if (method === "GET" && url.pathname === "/api/inbox/snapshot") {
        const refreshParam = parseBooleanParam(url.searchParams.get("refresh_index"));
        const syncParam = parseBooleanParam(url.searchParams.get("sync_index"));
        const inbox = await readInboxSnapshot(args, {
          refresh_index: refreshParam,
          sync_index: syncParam
        });
        sendJson(res, 200, inbox);
        return;
      }

      if (method === "GET" && url.pathname === "/api/usage/analytics") {
        const refreshParam = parseBooleanParam(url.searchParams.get("refresh_index"));
        const syncParam = parseBooleanParam(url.searchParams.get("sync_index"));
        const limitParam = url.searchParams.get("limit");
        const parsedLimit = limitParam == null ? undefined : Number(limitParam);
        const analytics = await buildUsageAnalyticsSnapshot({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          limit:
            parsedLimit !== undefined && Number.isFinite(parsedLimit) && parsedLimit > 0
              ? Math.floor(parsedLimit)
              : args.monitor_limit,
          refresh_index: refreshParam ?? args.refresh_index,
          sync_index: syncParam ?? args.sync_index
        });
        sendJson(res, 200, analytics);
        return;
      }

      if (method === "POST" && url.pathname === "/api/ui/resolve") {
        const body = (await readJsonBody(req)) as UiResolveBody;
        const artifactId = body.artifact_id?.trim();
        if (!artifactId) {
          sendJson(res, 400, { error: "artifact_id is required" });
          return;
        }
        const decision = body.decision;
        if (decision !== "approved" && decision !== "denied") {
          sendJson(res, 400, { error: "decision must be approved or denied" });
          return;
        }
        const result = await resolveInboxAndBuildUiSnapshot({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          artifact_id: artifactId,
          decision,
          actor_id: args.actor_id,
          actor_role: args.actor_role,
          actor_team_id: args.actor_team_id,
          notes: body.notes,
          monitor_limit: args.monitor_limit,
          pending_limit: args.pending_limit,
          decisions_limit: args.decisions_limit,
          refresh_index: false,
          sync_index: true
        });
        sendJson(res, 200, result);
        return;
      }

      if (method === "POST" && url.pathname === "/api/comments") {
        const body = (await readJsonBody(req)) as UiCommentBody;
        const text = body.body?.trim();
        if (!text) {
          sendJson(res, 400, { error: "body is required" });
          return;
        }
        const targetAgentId = body.target_agent_id?.trim();
        const targetArtifactId = body.target_artifact_id?.trim();
        const targetRunId = body.target_run_id?.trim();
        if (!targetAgentId && !targetArtifactId && !targetRunId) {
          sendJson(res, 400, {
            error: "at least one target is required (target_agent_id, target_artifact_id, target_run_id)"
          });
          return;
        }

        const created = await createComment({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          author_id: args.actor_id,
          author_role: args.actor_role,
          body: text,
          target_agent_id: targetAgentId,
          target_artifact_id: targetArtifactId,
          target_run_id: targetRunId,
          visibility: body.visibility
        });
        const snapshot = await buildUiSnapshot({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          monitor_limit: args.monitor_limit,
          pending_limit: args.pending_limit,
          decisions_limit: args.decisions_limit,
          comments_limit: args.comments_limit,
          refresh_index: false,
          sync_index: true
        });
        sendJson(res, 200, { comment: created.comment, snapshot });
        return;
      }

      if (method === "GET" && url.pathname === "/api/comments") {
        const targetAgentId = url.searchParams.get("target_agent_id")?.trim() || undefined;
        const targetArtifactId = url.searchParams.get("target_artifact_id")?.trim() || undefined;
        const targetRunId = url.searchParams.get("target_run_id")?.trim() || undefined;
        const limitRaw = url.searchParams.get("limit");
        const limitParsed = limitRaw == null ? undefined : Number.parseInt(limitRaw, 10);
        const limit =
          typeof limitParsed === "number" && Number.isInteger(limitParsed) && limitParsed > 0
            ? Math.min(limitParsed, 5000)
            : undefined;
        const comments = await listComments({
          workspace_dir: args.workspace_dir,
          project_id: args.project_id,
          target_agent_id: targetAgentId,
          target_artifact_id: targetArtifactId,
          target_run_id: targetRunId,
          limit: limit ?? args.comments_limit
        });
        sendJson(res, 200, { comments });
        return;
      }

      if (method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        res.write(": connected\n\n");

        let closed = false;
        let queueTimer: NodeJS.Timeout | null = null;
        const keepAliveTimer = setInterval(() => {
          if (closed) return;
          res.write(": keepalive\n\n");
        }, 15000);
        keepAliveTimer.unref?.();

        const pushSnapshot = async (): Promise<void> => {
          if (closed) return;
          try {
            const snap = await readSnapshot(args);
            res.write(`event: snapshot\\ndata: ${JSON.stringify(snap)}\\n\\n`);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            res.write(`event: error\\ndata: ${JSON.stringify({ message })}\\n\\n`);
          }
        };

        const scheduleSnapshot = (): void => {
          if (closed || queueTimer) return;
          queueTimer = setTimeout(() => {
            queueTimer = null;
            void pushSnapshot();
          }, 150);
          queueTimer.unref?.();
        };

        const unsub = subscribeRuntimeEvents((msg) => {
          if (projectFromEventsPath(msg.events_file_path) !== args.project_id) return;
          scheduleSnapshot();
        });

        void pushSnapshot();

        req.on("close", () => {
          closed = true;
          unsub();
          if (queueTimer) clearTimeout(queueTimer);
          clearInterval(keepAliveTimer);
          res.end();
        });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { error: message });
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off("error", onError);
        reject(err);
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (e) {
    unsubWorker();
    try {
      await worker.close();
    } finally {
      registerIndexSyncWorker(null);
    }
    throw e;
  }

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to read server address");
  }

  const actualHost = addr.address;
  const actualPort = addr.port;
  const url = `http://${actualHost}:${actualPort}`;

  return {
    host: actualHost,
    port: actualPort,
    url,
    close: async () => {
      unsubWorker();
      try {
        await worker.close();
      } finally {
        registerIndexSyncWorker(null);
        await new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
    }
  };
}
