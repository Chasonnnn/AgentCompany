function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderShell(input: {
  title: string;
  eyebrow: string;
  body: string;
  actions?: string;
  tone?: "neutral" | "danger";
}) {
  const toneColor = input.tone === "danger" ? "#991b1b" : "#16324f";
  const toneBackground = input.tone === "danger" ? "#fef2f2" : "#f5f9ff";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top left, rgba(15, 23, 42, 0.08), transparent 36%),
          linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
        color: #0f172a;
      }
      .card {
        width: min(540px, calc(100vw - 48px));
        border-radius: 20px;
        padding: 28px;
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(148, 163, 184, 0.18);
        box-shadow: 0 20px 48px rgba(15, 23, 42, 0.12);
        backdrop-filter: blur(12px);
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        background: ${toneBackground};
        color: ${toneColor};
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      h1 {
        margin: 18px 0 10px;
        font-size: 30px;
        line-height: 1.1;
      }
      .body {
        color: #334155;
        font-size: 14px;
        line-height: 1.6;
      }
      .actions {
        display: flex;
        gap: 10px;
        margin-top: 20px;
        flex-wrap: wrap;
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 10px 16px;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        color: white;
        background: #0f172a;
      }
      button.secondary {
        background: #e2e8f0;
        color: #0f172a;
      }
      pre {
        margin: 18px 0 0;
        padding: 14px;
        border-radius: 14px;
        background: #0f172a;
        color: #e2e8f0;
        font-size: 12px;
        line-height: 1.45;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 220px;
        overflow: auto;
      }
      .spinner {
        width: 16px;
        height: 16px;
        border-radius: 999px;
        border: 2px solid rgba(22, 50, 79, 0.18);
        border-top-color: ${toneColor};
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="eyebrow">${input.eyebrow}</div>
      <h1>${escapeHtml(input.title)}</h1>
      <div class="body">${input.body}</div>
      ${input.actions ? `<div class="actions">${input.actions}</div>` : ""}
    </main>
  </body>
</html>`;
}

export function toDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function renderSplashHtml(): string {
  return renderShell({
    eyebrow: '<span class="spinner" aria-hidden="true"></span> Starting local runtime',
    title: "Launching Paperclip",
    body: "Preparing the local server, storage, and static board UI. This window closes automatically when the control plane is ready.",
  });
}

export function renderStartupErrorHtml(input: {
  reason: string;
  logLines: string[];
}): string {
  const logText = input.logLines.length > 0 ? escapeHtml(input.logLines.join("\n")) : "No server logs captured.";
  return renderShell({
    eyebrow: "Startup failed",
    title: "Paperclip could not start",
    body: `
      <p>${escapeHtml(input.reason)}</p>
      <p>Check the local runtime logs or open the Paperclip data folder to inspect the instance state.</p>
      <pre>${logText}</pre>
    `,
    tone: "danger",
    actions: `
      <button type="button" onclick="window.paperclipDesktop?.openLogs?.()">Open Logs</button>
      <button type="button" class="secondary" onclick="window.paperclipDesktop?.openDataFolder?.()">Open Data Folder</button>
      <button type="button" class="secondary" onclick="window.paperclipDesktop?.reloadApp?.()">Retry</button>
    `,
  });
}
