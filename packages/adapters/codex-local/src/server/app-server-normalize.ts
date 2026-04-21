import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export type PendingUserInputOption = {
  label: string;
  description: string;
};

export type PendingUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: PendingUserInputOption[] | null;
};

export type PendingUserInputState = {
  requestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: PendingUserInputQuestion[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function optionKey(label: string, index: number) {
  return slugify(label) || `option-${index + 1}`;
}

function stringifyToolResultContent(item: Record<string, unknown>) {
  const textCandidates = [
    item.result,
    item.output,
    item.error,
    item.message,
    item.contentItems,
    item.arguments,
  ];
  for (const candidate of textCandidates) {
    const text = stringifyUnknown(candidate).trim();
    if (text) return text;
  }
  return "";
}

function normalizeThreadItem(item: Record<string, unknown>, phase: "started" | "completed") {
  const type = asString(item.type, "");

  if (type === "agentMessage") {
      return {
        type: "agent_message",
        id: asString(item.id, ""),
        text: asString(item.text, ""),
      };
  }

  if (type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.filter((value): value is string => typeof value === "string") : [];
    const content = Array.isArray(item.content) ? item.content.filter((value): value is string => typeof value === "string") : [];
      return {
        type: "reasoning",
        id: asString(item.id, ""),
        text: [...summary, ...content].filter(Boolean).join("\n").trim(),
        status: phase === "started" ? "in_progress" : "completed",
      };
  }

  if (type === "commandExecution") {
      return {
        type: "command_execution",
        id: asString(item.id, ""),
        command: asString(item.command, ""),
        aggregated_output: asString(item.aggregatedOutput, ""),
        exit_code: typeof item.exitCode === "number" ? item.exitCode : null,
        status:
        asString(item.status, "") === "inProgress"
          ? "in_progress"
          : asString(item.status, "").toLowerCase() || (phase === "started" ? "in_progress" : "completed"),
      };
  }

  if (type === "fileChange") {
      return {
        type: "file_change",
        id: asString(item.id, ""),
        changes: Array.isArray(item.changes) ? item.changes : [],
        status:
        asString(item.status, "") === "inProgress"
          ? "in_progress"
          : asString(item.status, "").toLowerCase() || (phase === "started" ? "in_progress" : "completed"),
      };
  }

  if (type === "mcpToolCall") {
    if (phase === "started") {
      return {
        type: "tool_use",
        id: asString(item.id, ""),
        name: [asString(item.server, ""), asString(item.tool, "")].filter(Boolean).join(":") || "mcp_tool_call",
        input: item.arguments ?? {},
        status: "in_progress",
      };
    }
    return {
      type: "tool_result",
      id: asString(item.id, ""),
      tool_use_id: asString(item.id, ""),
      content: stringifyToolResultContent(item),
      is_error: asString(item.status, "") === "failed" || item.error != null,
      status: asString(item.status, "").toLowerCase() || "completed",
    };
  }

  if (type === "dynamicToolCall" || type === "webSearch") {
    if (phase === "started") {
      return {
        type: "tool_use",
        id: asString(item.id, ""),
        name: type === "webSearch" ? "web_search" : asString(item.tool, "dynamic_tool_call"),
        input: parseObject(item.arguments) ?? item,
        status: "in_progress",
      };
    }
    return {
      type: "tool_result",
      id: asString(item.id, ""),
      tool_use_id: asString(item.id, ""),
      content: stringifyToolResultContent(item),
      is_error: asString(item.status, "") === "failed" || item.success === false,
      status: asString(item.status, "").toLowerCase() || "completed",
    };
  }

  if (type === "error") {
    return {
      type: "error",
      id: asString(item.id, ""),
      message: stringifyToolResultContent(item),
    };
  }

  return {
    type,
    ...item,
  };
}

export function normalizeAppServerNotification(input: {
  method: string;
  params: Record<string, unknown>;
  usageByTurn: Map<string, { input_tokens: number; cached_input_tokens: number; output_tokens: number }>;
}) {
  const { method, params, usageByTurn } = input;

  if (method === "thread/started") {
    const thread = parseObject(params.thread);
    const threadId = readNonEmptyString(thread.id);
    if (!threadId) return null;
    return {
      line: JSON.stringify({
        type: "thread.started",
        thread_id: threadId,
      }),
    };
  }

  if (method === "turn/started") {
    return {
      line: JSON.stringify({
        type: "turn.started",
      }),
    };
  }

  if (method === "item/started" || method === "item/completed") {
    const item = parseObject(params.item);
    if (!item) return null;
    const normalized = normalizeThreadItem(item, method === "item/started" ? "started" : "completed");
    return {
      line: JSON.stringify({
        type: method === "item/started" ? "item.started" : "item.completed",
        item: normalized,
      }),
    };
  }

  if (method === "thread/tokenUsage/updated") {
    const turnId = readNonEmptyString(params.turnId);
    const tokenUsage = parseObject(params.tokenUsage);
    const last = parseObject(tokenUsage.last);
    if (!turnId || !last) return null;
    usageByTurn.set(turnId, {
      input_tokens: typeof last.inputTokens === "number" ? last.inputTokens : 0,
      cached_input_tokens: typeof last.cachedInputTokens === "number" ? last.cachedInputTokens : 0,
      output_tokens: typeof last.outputTokens === "number" ? last.outputTokens : 0,
    });
    return null;
  }

  if (method === "turn/completed") {
    const turn = parseObject(params.turn);
    const turnId = readNonEmptyString(turn.id);
    const usage = turnId ? usageByTurn.get(turnId) : null;
    const error = parseObject(turn.error);
    if (asString(turn.status, "") === "failed") {
      return {
        line: JSON.stringify({
          type: "turn.failed",
          error: {
            message: asString(error.message, ""),
          },
          usage: usage ?? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
        }),
      };
    }
    return {
      line: JSON.stringify({
        type: "turn.completed",
        usage: usage ?? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
      }),
    };
  }

  if (method === "error") {
    const error = parseObject(params.error);
    return {
      line: JSON.stringify({
        type: "error",
        message: asString(error?.message, ""),
      }),
    };
  }

  return null;
}

export function normalizePendingUserInputQuestions(raw: unknown): PendingUserInputQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry != null)
    .map((entry) => ({
      id: asString(entry.id, ""),
      header: asString(entry.header, ""),
      question: asString(entry.question, ""),
      isOther: entry.isOther === true,
      isSecret: entry.isSecret === true,
      options: Array.isArray(entry.options)
        ? entry.options
            .map((option) => asRecord(option))
            .filter((option): option is Record<string, unknown> => option != null)
            .map((option) => ({
              label: asString(option.label, ""),
              description: asString(option.description, ""),
            }))
        : null,
    }))
    .filter((entry) => entry.id.length > 0 && entry.question.length > 0);
}

export function parsePendingUserInput(raw: unknown): PendingUserInputState | null {
  const record = asRecord(raw);
  if (!record) return null;
  const requestId = readNonEmptyString(record.requestId);
  const threadId = readNonEmptyString(record.threadId);
  const turnId = readNonEmptyString(record.turnId);
  const itemId = readNonEmptyString(record.itemId);
  if (!requestId || !threadId || !turnId || !itemId) return null;
  const questions = normalizePendingUserInputQuestions(record.questions);
  if (questions.length === 0) return null;
  return {
    requestId,
    threadId,
    turnId,
    itemId,
    questions,
  };
}

export function buildDecisionQuestionCapture(questions: PendingUserInputQuestion[]): {
  prompt: string;
  choices: Array<{ key: string; label: string; description?: string }>;
} | null {
  if (questions.length === 0) return null;

  if (questions.length === 1) {
    const [question] = questions;
    const prompt = [question.header, question.question].filter(Boolean).join(" - ").trim() || question.question;
    const choices = Array.isArray(question.options)
      ? question.options
          .filter((option) => option.label.trim().length > 0)
          .map((option, index) => ({
            key: optionKey(option.label, index),
            label: option.label.trim(),
            ...(option.description.trim().length > 0 ? { description: option.description.trim() } : {}),
          }))
      : [];
    return { prompt, choices };
  }

  const sections = questions.map((question, index) => {
    const letter = String.fromCharCode("A".charCodeAt(0) + index);
    const heading = [question.header, question.question].filter(Boolean).join(" - ").trim() || question.question;
    const optionLines = Array.isArray(question.options) && question.options.length > 0
      ? question.options
          .map((option, optionIndex) => {
            const description = option.description.trim();
            return `${optionIndex + 1}. ${option.label.trim()}${description ? ` - ${description}` : ""}`;
          })
          .join("\n")
      : "1. Other - Reply in your own words.";
    return `Decision ${letter} - ${heading}\n${optionLines}`;
  });

  return {
    prompt: sections.join("\n\n"),
    choices: [],
  };
}

export function buildPendingUserInputResponse(input: {
  questions: PendingUserInputQuestion[];
  selectedOptionKey?: string | null;
  answer?: string | null;
  note?: string | null;
}) {
  const responseText = readNonEmptyString(input.answer) ?? "";
  const noteText = readNonEmptyString(input.note);
  const answers: Record<string, { answers: string[] }> = {};

  for (const question of input.questions) {
    let resolved = responseText;
    if (question.options && input.selectedOptionKey) {
      const selected = question.options.find((option, index) => optionKey(option.label, index) === input.selectedOptionKey) ?? null;
      if (selected) resolved = selected.label.trim();
    }
    const parts = [resolved, noteText].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    answers[question.id] = {
      answers: parts.length > 0 ? parts : (responseText ? [responseText] : ["Other"]),
    };
  }

  return { answers };
}
