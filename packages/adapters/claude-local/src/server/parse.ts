import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

const CLAUDE_AUTH_REQUIRED_RE = /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+`?claude\s+login`?|login\s+required|requires\s+login|unauthorized|authentication\s+required)/i;
const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;
const CLAUDE_NATIVE_QUESTION_TOOL_NAME = "AskUserQuestion";

function normalizeChoiceKey(input: string, index: number): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `option-${index + 1}`;
}

function normalizeClaudeQuestionInput(input: unknown) {
  if (typeof input === "string") {
    const prompt = input.trim();
    return prompt ? { prompt, choices: [] } : null;
  }

  const obj = parseObject(input);

  // Claude Code's native AskUserQuestion tool wraps payloads in `{ questions: [...] }`
  // where each entry is `{ question, header, multiSelect, options: [{ label, description }] }`.
  // Capture the first entry — Paperclip decision questions are one-question artifacts.
  if (Array.isArray(obj.questions) && obj.questions.length > 0) {
    return normalizeClaudeQuestionInput(obj.questions[0]);
  }

  const prompt =
    asString(obj.prompt, "").trim() ||
    asString(obj.question, "").trim() ||
    asString(obj.message, "").trim() ||
    asString(obj.text, "").trim() ||
    asString(obj.body, "").trim() ||
    [
      asString(obj.title, "").trim(),
      asString(obj.description, "").trim() || asString(obj.detail, "").trim(),
    ].filter(Boolean).join("\n\n");
  if (!prompt) return null;

  const rawChoices = Array.isArray(obj.choices)
    ? obj.choices
    : Array.isArray(obj.options)
      ? obj.options
      : Array.isArray(obj.suggested_responses)
        ? obj.suggested_responses
        : [];
  const seenKeys = new Set<string>();
  const choices = rawChoices.flatMap((choiceRaw, index) => {
    if (typeof choiceRaw === "string") {
      const label = choiceRaw.trim();
      if (!label) return [];
      let key = normalizeChoiceKey(label, index);
      while (seenKeys.has(key)) key = `${key}-${index + 1}`;
      seenKeys.add(key);
      return [{ key, label }];
    }

    const choice = parseObject(choiceRaw);
    const label =
      asString(choice.label, "").trim() ||
      asString(choice.title, "").trim() ||
      asString(choice.text, "").trim() ||
      asString(choice.message, "").trim();
    if (!label) return [];

    let key =
      asString(choice.key, "").trim() ||
      asString(choice.id, "").trim() ||
      asString(choice.value, "").trim() ||
      normalizeChoiceKey(label, index);
    while (seenKeys.has(key)) key = `${key}-${index + 1}`;
    seenKeys.add(key);

    const description =
      asString(choice.description, "").trim() ||
      asString(choice.detail, "").trim() ||
      asString(choice.subtitle, "").trim() ||
      asString(choice.reason, "").trim();

    return [{
      key,
      label,
      ...(description ? { description } : {}),
    }];
  });

  return {
    prompt,
    choices,
  };
}

export function parseClaudeStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];
  let question: { prompt: string; choices: Array<{ key: string; label: string; description?: string }> } | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      const message = parseObject(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block.type, "") === "text") {
          const text = asString(block.text, "");
          if (text) assistantTexts.push(text);
          continue;
        }
        if (
          !question &&
          asString(block.type, "") === "tool_use" &&
          asString(block.name, "") === CLAUDE_NATIVE_QUESTION_TOOL_NAME
        ) {
          question = normalizeClaudeQuestionInput(block.input);
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
      question,
    };
  }

  const usageObj = parseObject(finalResult.usage);
  const usage: UsageSummary = {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    cacheCreationInputTokens: asNumber(usageObj.cache_creation_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  return {
    sessionId,
    model,
    costUsd,
    usage,
    summary,
    resultJson: finalResult,
    question,
  };
}

function extractClaudeErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }

    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function extractClaudeLoginUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

export function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const resultText = asString(input.parsed?.result, "").trim();
  const messages = [resultText, ...extractClaudeErrorMessages(input.parsed ?? {}), input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requiresLogin = messages.some((line) => CLAUDE_AUTH_REQUIRED_RE.test(line));
  return {
    requiresLogin,
    loginUrl: extractClaudeLoginUrl([input.stdout, input.stderr].join("\n")),
  };
}

export function describeClaudeFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = extractClaudeErrorMessages(parsed);

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Claude run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isClaudeMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "error_max_turns") return true;

  const stopReason = asString(parsed.stop_reason, "").trim().toLowerCase();
  if (stopReason === "max_turns") return true;

  const resultText = asString(parsed.result, "").trim();
  return /max(?:imum)?\s+turns?/i.test(resultText);
}

export function isClaudeUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found/i.test(msg),
  );
}

export function isClaudeRecoverableResumeFilesystemError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /api error:\s*enoent:\s*no such file or directory,\s*mkdir\b/i.test(msg),
  );
}
