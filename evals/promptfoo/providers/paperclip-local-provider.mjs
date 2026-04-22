const DEFAULT_BASE_URL = "http://127.0.0.1:3100";
const DEFAULT_TIMEOUT_MS = 180_000;

function normalizeBaseUrl(value) {
  const raw = typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : (process.env.PAPERCLIP_COMPONENT_EVAL_BASE_URL ?? DEFAULT_BASE_URL);
  return raw.replace(/\/+$/, "");
}

function coerceTimeoutMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return DEFAULT_TIMEOUT_MS;
}

function buildFailurePayload(adapterType, message) {
  return {
    executionStatus: "failed",
    adapterType,
    modelId: null,
    finalText: "",
    durationMs: 0,
    stderrExcerpt: null,
    traceSummary: {
      eventKinds: [],
      toolNames: [],
      sessionId: null,
      warnings: [message],
    },
    rawTranscript: null,
    errorMessage: message,
  };
}

export default class PaperclipLocalProvider {
  constructor(options = {}) {
    this.providerId = options.label || options.id || "paperclip-local";
    this.adapterType = options.config?.adapterType || "codex_local";
    this.baseUrl = normalizeBaseUrl(options.config?.baseUrl);
    this.timeoutMs = coerceTimeoutMs(options.config?.timeoutMs);
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    const caseId =
      context?.vars?.caseId ||
      context?.test?.vars?.caseId ||
      `component-eval-${this.adapterType}`;
    const body = {
      caseId,
      adapterType: this.adapterType,
      prompt,
      vars: context?.vars ?? {},
      timeoutMs: this.timeoutMs,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/instance/evals/component-run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? `${payload.error} (${response.status})`
            : `Component eval request failed with status ${response.status}.`;
        const failurePayload = {
          ...buildFailurePayload(this.adapterType, message),
          ...(payload && typeof payload === "object" ? payload : {}),
          errorMessage: message,
        };
        return {
          error: message,
          output: JSON.stringify(failurePayload),
          raw: payload,
        };
      }

      return {
        output: JSON.stringify(payload),
        raw: payload,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? `Component eval provider request failed: ${error.message}`
          : "Component eval provider request failed.";
      return {
        error: message,
        output: JSON.stringify(buildFailurePayload(this.adapterType, message)),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
