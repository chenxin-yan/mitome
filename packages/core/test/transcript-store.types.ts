import { Effect } from "effect";
import { TranscriptNotFound } from "../src/index.js";
import type { TranscriptStore } from "../src/index.js";

const externalStore: TranscriptStore = {
  save: () => Effect.void,
  load: (id) => Effect.fail(new TranscriptNotFound({ id })),
  list: () => Effect.succeed([]),
  appendEvent: () => Effect.void,
};

void externalStore;
