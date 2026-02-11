import http from "node:http";
import path from "node:path";
import { buildUiSnapshot, type UiSnapshot } from "../runtime/ui_bundle.js";
import { resolveInboxAndBuildUiSnapshot } from "./resolve_and_snapshot.js";
import { subscribeRuntimeEvents } from "../runtime/event_bus.js";
import type { ActorRole } from "../policy/policy.js";

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

function projectFromEventsPath(eventsPath: string): string | undefined {
  const normalized = eventsPath.split(path.sep).join("/");
  const m = normalized.match(/\/work\/projects\/([^/]+)\/runs\/[^/]+\/events\.jsonl$/);
  return m?.[1];
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
        <span># recent-decisions</span><span class="count" id="summaryErrors">0</span>
      </button>

      <div class="sidebar-foot">
        <div id="syncState" class="sync-state"></div>
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
              <tr><th>Run</th><th>Status</th><th>Live</th><th>Last Event</th><th>Parse Errors</th></tr>
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

      <p id="error" class="err"></p>
    </main>
  </div>

  <script>
    const INIT = ${init};

    const metaEl = document.getElementById('meta');
    const syncEl = document.getElementById('syncState');
    const errorEl = document.getElementById('error');
    const navProject = document.getElementById('navProject');
    const navActor = document.getElementById('navActor');
    const navRole = document.getElementById('navRole');
    const summaryPending = document.getElementById('summaryPending');
    const summaryRuns = document.getElementById('summaryRuns');
    const summaryErrors = document.getElementById('summaryErrors');
    const pendingBody = document.getElementById('pendingBody');
    const decisionsBody = document.getElementById('decisionsBody');
    const runsBody = document.getElementById('runsBody');
    const refreshBtn = document.getElementById('refreshBtn');
    const tabButtons = Array.from(document.querySelectorAll('[data-tab-target]'));
    const panes = Array.from(document.querySelectorAll('[data-pane]'));

    let state = null;

    function esc(v) {
      return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    }

    function setError(msg) {
      errorEl.textContent = msg ? String(msg) : '';
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

    function render(snapshot) {
      state = snapshot;
      navProject.textContent = INIT.project_id;
      navActor.textContent = INIT.actor_id;
      navRole.textContent = INIT.actor_role;
      metaEl.textContent = 'updated ' + snapshot.generated_at + ' · replayable event log';
      syncEl.textContent = 'sync: ' + (snapshot.index_sync_worker.enabled ? 'on' : 'off') + ', pending=' + snapshot.index_sync_worker.pending_workspaces;

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
      summaryErrors.textContent = String(decisions.length);
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
        return '<tr>' +
          '<td class="mono">' + esc(r.run_id) + '</td>' +
          '<td>' + esc(r.run_status) + '</td>' +
          '<td>' + esc(r.live_status || '-') + '</td>' +
          '<td>' + esc(r.last_event ? r.last_event.type : '-') + '</td>' +
          '<td>' + esc(r.parse_error_count) + '</td>' +
        '</tr>';
      }).join('');
    }

    async function fetchSnapshot() {
      const res = await fetch('/api/ui/snapshot', { method: 'GET' });
      if (!res.ok) throw new Error('snapshot failed: ' + res.status);
      const body = await res.json();
      render(body);
      setError('');
      return body;
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
        activatePane(target);
      });
    });

    refreshBtn.addEventListener('click', async () => {
      try {
        await fetchSnapshot();
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
      activatePane('pending');
      let es = null;
      try {
        await fetchSnapshot();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }

      try {
        es = setupSse();
      } catch {
        // ignore
      }

      setInterval(async () => {
        if (es && es.readyState === 1) return;
        try {
          await fetchSnapshot();
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
    refresh_index: args.refresh_index,
    sync_index: args.sync_index
  });
}

export async function startUiWebServer(args: UiWebServerArgs): Promise<UiWebServer> {
  const host = args.host?.trim() || "127.0.0.1";
  const port = Number.isInteger(args.port) ? Number(args.port) : 8787;

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
          refresh_index: refreshParam ?? args.refresh_index,
          sync_index: syncParam ?? args.sync_index
        });
        sendJson(res, 200, snap);
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
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  };
}
