/**
 * Dynamic UI parser loading for external adapters.
 *
 * External adapters ship `ui-parser.js` as an ESM module. When the browser
 * supports module workers, Paperclip loads that module inside a dedicated
 * worker and asks the worker to build transcripts off the main thread.
 *
 * If Worker support is unavailable, we fall back to the prior blob-import
 * path so external adapters still function in constrained environments.
 */

import { parseProcessStdoutLine } from "./process/parse-stdout";
import { buildTranscript, type RunLogChunk, type TranscriptBuildOptions } from "./transcript";
import type {
  StatefulStdoutParser,
  StdoutLineParser,
  StdoutParserFactory,
  TranscriptBuilder,
  TranscriptEntry,
} from "./types";

interface DynamicParserModule {
  parseStdoutLine: StdoutLineParser;
  createStdoutParser?: StdoutParserFactory;
  buildTranscriptAsync?: TranscriptBuilder;
}

type WorkerLoadResponse = { ok: true } | { ok: false; error: string };
type WorkerTranscriptResponse = { ok: true; entries: TranscriptEntry[] } | { ok: false; error: string };
type WorkerInvalidateResponse = { ok: true } | { ok: false; error: string };

type WorkerMessage =
  | { kind: "load"; adapterType: string; source: string }
  | { kind: "buildTranscript"; adapterType: string; chunks: RunLogChunk[]; opts?: TranscriptBuildOptions }
  | { kind: "invalidate"; adapterType: string };

type WorkerRequest = WorkerMessage & { id: number };

type WorkerResponse =
  | ({ id: number; kind: "load" } & WorkerLoadResponse)
  | ({ id: number; kind: "buildTranscript" } & WorkerTranscriptResponse)
  | ({ id: number; kind: "invalidate" } & WorkerInvalidateResponse);

const dynamicParserCache = new Map<string, DynamicParserModule>();
const failedLoads = new Set<string>();
const pendingWorkerRequests = new Map<number, {
  resolve: (value: WorkerResponse) => void;
  reject: (error: unknown) => void;
}>();

let parserWorker: Worker | null = null;
let parserWorkerRequestId = 1;

function buildWorkerBackedModule(adapterType: string): DynamicParserModule {
  return {
    parseStdoutLine: parseProcessStdoutLine,
    buildTranscriptAsync: async (chunks, opts) => {
      const result = await callParserWorker({
        kind: "buildTranscript",
        adapterType,
        chunks,
        opts,
      });
      if (result.kind !== "buildTranscript" || !result.ok) {
        throw new Error(result.kind === "buildTranscript" ? result.error : "unexpected parser worker response");
      }
      return result.entries;
    },
  };
}

function resetParserWorker() {
  if (parserWorker) {
    parserWorker.terminate();
    parserWorker = null;
  }
  for (const pending of pendingWorkerRequests.values()) {
    pending.reject(new Error("parser worker terminated"));
  }
  pendingWorkerRequests.clear();
}

function getParserWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (parserWorker) return parserWorker;

  parserWorker = new Worker(new URL("./sandboxed-parser-worker.ts", import.meta.url), { type: "module" });
  parserWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const pending = pendingWorkerRequests.get(event.data.id);
    if (!pending) return;
    pendingWorkerRequests.delete(event.data.id);
    if ("ok" in event.data && event.data.ok) {
      pending.resolve(event.data);
      return;
    }
    pending.reject(new Error("error" in event.data ? event.data.error : "parser worker request failed"));
  };
  parserWorker.onerror = () => {
    resetParserWorker();
  };
  return parserWorker;
}

function callParserWorker(
  request: WorkerMessage,
): Promise<WorkerResponse> {
  const worker = getParserWorker();
  if (!worker) {
    return Promise.reject(new Error("module workers are unavailable"));
  }

  const id = parserWorkerRequestId++;
  return new Promise<WorkerResponse>((resolve, reject) => {
    pendingWorkerRequests.set(id, { resolve, reject });
    const message: WorkerRequest = {
      id,
      ...request,
    };
    worker.postMessage(message);
  });
}

async function importParserModuleFromSource(source: string, adapterType: string): Promise<DynamicParserModule | null> {
  const blob = new Blob([source], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);

  try {
    const mod = await import(/* @vite-ignore */ blobUrl);

    let parserModule: DynamicParserModule;
    if (typeof mod.createStdoutParser === "function") {
      const createStdoutParser = mod.createStdoutParser as StdoutParserFactory;
      parserModule = {
        createStdoutParser,
        parseStdoutLine:
          typeof mod.parseStdoutLine === "function"
            ? (mod.parseStdoutLine as StdoutLineParser)
            : ((line: string, ts: string) => {
                const parser = createStdoutParser() as StatefulStdoutParser;
                const entries = parser.parseLine(line, ts);
                parser.reset();
                return entries;
              }),
      };
    } else if (typeof mod.parseStdoutLine === "function") {
      parserModule = {
        parseStdoutLine: mod.parseStdoutLine as StdoutLineParser,
      };
    } else {
      console.warn(
        `[adapter-ui-loader] Module for "${adapterType}" exports neither parseStdoutLine nor createStdoutParser`,
      );
      return null;
    }

    return {
      ...parserModule,
      buildTranscriptAsync: async (chunks, opts) => buildTranscript(chunks, parserModule, opts),
    };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export async function loadDynamicParser(adapterType: string): Promise<DynamicParserModule | null> {
  const cached = dynamicParserCache.get(adapterType);
  if (cached) return cached;
  if (failedLoads.has(adapterType)) return null;

  try {
    const response = await fetch(`/api/adapters/${encodeURIComponent(adapterType)}/ui-parser.js`);
    if (!response.ok) {
      failedLoads.add(adapterType);
      return null;
    }

    const source = await response.text();

    let parserModule: DynamicParserModule | null = null;
    try {
      const workerResult = await callParserWorker({ kind: "load", adapterType, source });
      if (workerResult.kind !== "load" || !workerResult.ok) {
        throw new Error(workerResult.kind === "load" ? workerResult.error : "unexpected parser worker response");
      }
      parserModule = buildWorkerBackedModule(adapterType);
    } catch (workerError) {
      console.warn(
        `[adapter-ui-loader] Worker parser load failed for "${adapterType}", falling back to main thread import:`,
        workerError,
      );
      parserModule = await importParserModuleFromSource(source, adapterType);
    }

    if (!parserModule) {
      failedLoads.add(adapterType);
      return null;
    }

    dynamicParserCache.set(adapterType, parserModule);
    console.info(`[adapter-ui-loader] Loaded dynamic UI parser for "${adapterType}"`);
    return parserModule;
  } catch (err) {
    console.warn(`[adapter-ui-loader] Failed to load UI parser for "${adapterType}":`, err);
    failedLoads.add(adapterType);
    return null;
  }
}

export function invalidateDynamicParser(adapterType: string): boolean {
  const wasCached = dynamicParserCache.has(adapterType);
  dynamicParserCache.delete(adapterType);
  failedLoads.delete(adapterType);
  void callParserWorker({ kind: "invalidate", adapterType }).catch(() => undefined);
  if (wasCached) {
    console.info(`[adapter-ui-loader] Invalidated dynamic UI parser for "${adapterType}"`);
  }
  return wasCached;
}
