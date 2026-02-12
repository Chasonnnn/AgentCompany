type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

function resolveInvoke():
  | ((command: string, args?: Record<string, unknown>) => Promise<unknown>)
  | null {
  const v1 = (window as any).__TAURI__?.core?.invoke;
  if (typeof v1 === "function") {
    return v1;
  }
  const v2 = (window as any).__TAURI_INTERNALS__?.invoke;
  if (typeof v2 === "function") {
    return (command: string, args?: Record<string, unknown>) => v2(command, args ?? {});
  }
  return null;
}

export async function rpcCall<T>(method: string, params: Record<string, JsonValue>): Promise<T> {
  const invoke = resolveInvoke();
  if (!invoke) {
    throw new Error("Tauri runtime is unavailable. Launch AgentCompany desktop app.");
  }
  const result = await invoke("rpc_call", {
    args: {
      method,
      params
    }
  });
  return result as T;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function parseRepoIds(raw: string): string[] {
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

