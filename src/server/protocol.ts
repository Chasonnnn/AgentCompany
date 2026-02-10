export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcError = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
};

export const JSONRPC = "2.0";

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isRequest(v: unknown): v is JsonRpcRequest {
  if (!isObject(v)) return false;
  if (v.jsonrpc !== JSONRPC) return false;
  if (typeof v.method !== "string" || v.method.length === 0) return false;
  return "id" in v;
}

export function isNotification(v: unknown): v is JsonRpcNotification {
  if (!isObject(v)) return false;
  if (v.jsonrpc !== JSONRPC) return false;
  if (typeof v.method !== "string" || v.method.length === 0) return false;
  return !("id" in v);
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC, id, result };
}

export function error(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: JSONRPC, id, error: { code, message, data } };
}

