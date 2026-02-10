import { appendEventJsonl, type EventEnvelope } from "./events.js";

export type EventWriter = {
  write: <TPayload>(ev: EventEnvelope<TPayload>) => void;
  flush: () => Promise<void>;
};

export function createEventWriter(eventsFilePath: string): EventWriter {
  let chain: Promise<void> = Promise.resolve();

  return {
    write: (ev) => {
      chain = chain.then(() => appendEventJsonl(eventsFilePath, ev));
    },
    flush: async () => {
      await chain;
    }
  };
}

