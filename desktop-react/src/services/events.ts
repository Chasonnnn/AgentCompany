import { listen } from "@tauri-apps/api/event";

export type Unsubscribe = () => void;

type Listener<T> = (payload: T) => void;

function createEventHub<T>(eventName: string) {
  const listeners = new Set<Listener<T>>();
  let unlisten: Unsubscribe | null = null;
  let opening: Promise<void> | null = null;

  const start = () => {
    if (opening || unlisten) return;
    opening = listen<T>(eventName, (event) => {
      for (const listener of listeners) {
        try {
          listener(event.payload);
        } catch (error) {
          console.error(`[events] ${eventName} listener error`, error);
        }
      }
    })
      .then((fn) => {
        opening = null;
        if (listeners.size === 0) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((error) => {
        opening = null;
        console.error(`[events] failed to subscribe ${eventName}`, error);
      });
  };

  const stop = () => {
    if (unlisten) {
      try {
        unlisten();
      } catch {
        // no-op
      }
      unlisten = null;
    }
  };

  return {
    subscribe(listener: Listener<T>): Unsubscribe {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    }
  };
}

export const contextCycleEventHub = createEventHub<{
  run_id: string;
  agent_id?: string;
  provider?: string;
  context_cycles_count?: number;
}>("context-cycle-detected");

export const indexSyncEventHub = createEventHub<{
  workspace_dir: string;
  status: string;
}>("index-sync-worker");
