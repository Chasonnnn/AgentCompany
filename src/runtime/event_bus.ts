type RuntimeEventMessage = {
  events_file_path: string;
  event: unknown;
};

type RuntimeEventHandler = (msg: RuntimeEventMessage) => void;

const HANDLERS = new Set<RuntimeEventHandler>();

export function subscribeRuntimeEvents(handler: RuntimeEventHandler): () => void {
  HANDLERS.add(handler);
  return () => {
    HANDLERS.delete(handler);
  };
}

export function publishRuntimeEvent(msg: RuntimeEventMessage): void {
  for (const h of HANDLERS) {
    try {
      h(msg);
    } catch {
      // Subscribers must not break event publishing.
    }
  }
}

