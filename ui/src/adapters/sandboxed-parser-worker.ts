import { buildTranscript, type RunLogChunk, type TranscriptBuildOptions } from "./transcript";
import type { StatefulStdoutParser, StdoutLineParser, StdoutParserFactory, TranscriptEntry } from "./types";

type DynamicParserModule = {
  parseStdoutLine: StdoutLineParser;
  createStdoutParser?: StdoutParserFactory;
};

type WorkerRequest =
  | { id: number; kind: "load"; adapterType: string; source: string }
  | { id: number; kind: "buildTranscript"; adapterType: string; chunks: RunLogChunk[]; opts?: TranscriptBuildOptions }
  | { id: number; kind: "invalidate"; adapterType: string };

type WorkerResponse =
  | { id: number; kind: "load"; ok: true }
  | { id: number; kind: "load"; ok: false; error: string }
  | { id: number; kind: "buildTranscript"; ok: true; entries: TranscriptEntry[] }
  | { id: number; kind: "buildTranscript"; ok: false; error: string }
  | { id: number; kind: "invalidate"; ok: true }
  | { id: number; kind: "invalidate"; ok: false; error: string };

const parserModules = new Map<string, DynamicParserModule>();

function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function loadParserModule(adapterType: string, source: string) {
  const existing = parserModules.get(adapterType);
  if (existing) return existing;

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
      throw new Error(`Module for "${adapterType}" exports neither parseStdoutLine nor createStdoutParser`);
    }

    parserModules.set(adapterType, parserModule);
    return parserModule;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    if (request.kind === "load") {
      await loadParserModule(request.adapterType, request.source);
      const response: WorkerResponse = { id: request.id, kind: "load", ok: true };
      self.postMessage(response);
      return;
    }

    if (request.kind === "buildTranscript") {
      const parserModule = parserModules.get(request.adapterType);
      if (!parserModule) {
        throw new Error(`Parser for "${request.adapterType}" is not loaded`);
      }
      const entries = buildTranscript(request.chunks, parserModule, request.opts);
      const response: WorkerResponse = { id: request.id, kind: "buildTranscript", ok: true, entries };
      self.postMessage(response);
      return;
    }

    parserModules.delete(request.adapterType);
    const response: WorkerResponse = { id: request.id, kind: "invalidate", ok: true };
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      id: request.id,
      kind: request.kind,
      ok: false,
      error: toErrorMessage(error),
    };
    self.postMessage(response);
  }
};
