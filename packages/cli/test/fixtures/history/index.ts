// An offline Configuration that keeps its conversations in this process's memory, so that
// `--continue` is tested without a store on disk: in the store MITOME_FIXTURE_HISTORY names when it
// is acquired, so that each test can start from an empty one. Its Model answers with every user
// text in its Model Context, so a reply shows what a continued conversation remembered.
import { Effect, Layer, Stream } from "effect";
import { LanguageModel } from "effect/ai";
import {
  Agent,
  Mitome,
  Provider,
  type Session,
  SessionSaveError,
  TranscriptError,
  Transcripts,
  withModelRequestAccounting,
} from "@mitome/core";
import { terminal } from "@mitome/core/terminal";

/** One store's conversations by id, and the one most recently written under each scope. */
interface Store {
  readonly conversations: Map<string, Session.Transcript>;
  readonly latest: Map<string, string>;
}
const stores = new Map<string, Store>();

const transcript = (store: Store, id: string, scope: string): Session.Transcript => {
  const entries = new Map<string, Session.Entry>();
  let stored: string | undefined;
  const branch = (position: string | undefined) => {
    const found: Array<Session.Entry> = [];
    for (let at = position; at !== undefined; at = entries.get(at)?.parent) {
      const entry = entries.get(at);
      if (entry !== undefined) {
        found.unshift(entry);
      }
    }
    return found;
  };
  const conflict = Effect.suspend(() => Effect.fail(new SessionSaveError({ outcome: "conflict" })));
  return {
    id,
    open: Effect.sync(() => ({ position: stored, branch: branch(stored) })),
    append: (entry, expected) =>
      Effect.suspend(() => {
        if (expected !== stored) {
          return conflict;
        }
        entries.set(entry.id, entry);
        stored = entry.id;
        store.latest.set(scope, id);
        return Effect.void;
      }),
    select: (position, expected) =>
      Effect.suspend(
        (): Effect.Effect<Array<Session.Entry>, SessionSaveError | TranscriptError> => {
          if (expected !== stored) {
            return conflict;
          }
          if (position !== undefined && !entries.has(position)) {
            return Effect.fail(new TranscriptError({ detail: `no Entry "${position}"` }));
          }
          stored = position;
          store.latest.set(scope, id);
          return Effect.succeed(branch(position));
        },
      ),
    tree: Effect.sync(() => Array.from(entries.values(), ({ id, parent }) => ({ id, parent }))),
  };
};

const model = withModelRequestAccounting(
  "fixture",
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: ({ prompt }) => {
        const said = prompt.content.flatMap((message) =>
          message.role === "user"
            ? message.content.map((part) => (part.type === "text" ? part.text : ""))
            : [],
        );
        return Effect.succeed([
          { type: "text", text: `heard: ${said.join(", ")}` },
          { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } },
        ]);
      },
      streamText: () => Stream.die(new Error("not streamed")),
    }),
  ),
);

/** Answers with every user text in its Model Context. */
export const remembering = Provider.make("scripted", {
  modelIds: ["remember"],
  provision: () => model,
});

const transcripts = Layer.sync(Transcripts, () => {
  const name = process.env.MITOME_FIXTURE_HISTORY ?? "";
  const store = stores.get(name) ?? { conversations: new Map(), latest: new Map() };
  stores.set(name, store);
  return {
    // Recorded as the latest as soon as it is created, as a store may, which a CLI that opens
    // its conversation too early would show; every write makes it the latest again.
    create: (scope) =>
      Effect.sync(() => {
        const made = transcript(store, crypto.randomUUID(), scope);
        store.conversations.set(made.id, made);
        store.latest.set(scope, made.id);
        return made;
      }),
    latest: (scope) => Effect.sync(() => store.conversations.get(store.latest.get(scope) ?? "")),
    open: (id) => Effect.sync(() => store.conversations.get(id)),
  };
});

export default Mitome.make({
  agent: Agent.make({
    // Refuses `unparseable`, as an Agent's own text mapping may.
    text: {
      parse: (text: string) =>
        text === "unparseable" ? Effect.fail("unparseable input") : Effect.succeed(text),
      render: (text: string) => Effect.succeed(text),
    },
  }),
  provide: [terminal({ keys: { enter: terminal.submit, "ctrl+d": "/quit" } }), transcripts],
  providers: [remembering],
  model: "scripted/remember",
});
