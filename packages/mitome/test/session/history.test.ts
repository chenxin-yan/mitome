import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect";
import { AiError, Prompt, Tool, Toolkit } from "effect/ai";
import {
  SessionBusyError,
  SessionFencedError,
  SessionSaveError,
  TranscriptError,
  Turn,
} from "../../src/index.js";
import { localTools, Session, step } from "../../src/kernel.js";
import { call, finish, scriptedModel, text } from "../support/step.js";
import { recordingTranscript } from "../support/transcript.js";

const Read = Tool.make("read", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
});
const tools = localTools(Toolkit.make(Read), { read: ({ key }) => Effect.succeed(`read ${key}`) });

const message = (value: string): Prompt.Message =>
  Prompt.userMessage({ content: [Prompt.textPart({ text: value })] });

const user = (value: string) =>
  Effect.gen(function* () {
    const turn = yield* Turn;
    yield* turn.stage(message(value));
  });

const roles = (messages: ReadonlyArray<Prompt.Message>) => messages.map((entry) => entry.role);

const texts = (messages: ReadonlyArray<Prompt.Message>) =>
  messages.map((entry) =>
    entry.role === "user" && entry.content[0]?.type === "text" ? entry.content[0].text : entry.role,
  );

const notWritten = new SessionSaveError({ outcome: "not-written" });

describe("Session history as a tree of Steps", () => {
  it.effect("commits each completed Step as one Entry under the position", () =>
    Effect.gen(function* () {
      const { transcript, stored } = recordingTranscript();
      const session = yield* Session.make({ transcript });
      const log: Array<string> = [];
      yield* session.run(
        Effect.gen(function* () {
          const registered = yield* tools;
          yield* user("go");
          yield* step({ tools: registered });
          yield* step({ tools: registered });
        }).pipe(
          Effect.provide(
            scriptedModel(
              [
                [call("c1", "read"), finish("tool-calls")],
                [text("done"), finish("stop")],
              ],
              log,
            ),
          ),
        ),
      );

      const [turn] = yield* session.turns;
      expect(turn).toMatchObject({ phase: "succeeded" });
      const [first, second] = turn?.entries ?? [];
      expect(turn?.entries).toHaveLength(2);
      expect(Array.from(stored.entries.values(), (entry) => roles(entry.messages))).toEqual([
        ["user", "assistant", "tool"],
        ["assistant"],
      ]);
      expect(yield* session.position).toBe(second);
      expect(stored.position).toBe(second);
      expect(yield* session.tree).toEqual([
        { id: first, parent: undefined },
        { id: second, parent: first },
      ]);
      expect(roles(yield* session.history)).toEqual(["user", "assistant", "tool", "assistant"]);
    }),
  );

  it.effect("keeps the Entries of a Turn interrupted after two Steps for the next Turn", () =>
    Effect.gen(function* () {
      const { transcript, stored } = recordingTranscript();
      const session = yield* Session.make({ transcript });
      const log: Array<string> = [];
      const steppedTwice = yield* Deferred.make<void>();
      const interrupted = yield* Effect.forkChild(
        session.run(
          Effect.gen(function* () {
            const registered = yield* tools;
            yield* user("go");
            yield* step({ tools: registered });
            yield* step({ tools: registered });
            yield* user("dropped");
            yield* Deferred.succeed(steppedTwice, undefined);
            return yield* Effect.never;
          }).pipe(
            Effect.provide(
              scriptedModel(
                [
                  [call("c1", "read"), finish("tool-calls")],
                  [call("c2", "read"), finish("tool-calls")],
                ],
                log,
              ),
            ),
          ),
        ),
      );
      yield* Deferred.await(steppedTwice);
      yield* Fiber.interrupt(interrupted);

      const [turn] = yield* session.turns;
      expect(turn?.phase).toBe("failed");
      expect(turn?.entries).toHaveLength(2);
      expect(stored.entries.size).toBe(2);
      expect(texts(yield* session.history)).toEqual([
        "go",
        "assistant",
        "tool",
        "assistant",
        "tool",
      ]);

      yield* session.run(
        Effect.andThen(user("again"), step()).pipe(
          Effect.provide(scriptedModel([[text("ok")]], log)),
        ),
      );
      // The next Turn's Model Context holds both kept Steps before its own prompt.
      expect(log).toEqual(["generate:1", "generate:3", "generate:6"]);
    }),
  );

  it.effect("keeps nothing of a Turn that fails before its first Step completes", () =>
    Effect.gen(function* () {
      const { transcript, stored } = recordingTranscript();
      const session = yield* Session.make({ transcript });
      const failure = AiError.make({
        module: "test",
        method: "generateText",
        reason: new AiError.UnknownError({ description: "down" }),
      });
      const exit = yield* Effect.exit(
        session.run(
          Effect.andThen(user("go"), step()).pipe(
            Effect.provide(scriptedModel([Effect.fail(failure)], [])),
          ),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* session.history).toEqual([]);
      expect(yield* session.position).toBeUndefined();
      expect(stored.entries.size).toBe(0);
      expect((yield* session.turns)[0]).toMatchObject({ phase: "failed", entries: [] });
    }),
  );

  it.effect("commits Messages staged after the last Step as a last Entry on success", () =>
    Effect.gen(function* () {
      const { transcript, stored } = recordingTranscript();
      const session = yield* Session.make({ transcript });
      yield* session.run(
        Effect.gen(function* () {
          yield* user("go");
          yield* step();
          yield* user("after");
        }).pipe(Effect.provide(scriptedModel([[text("hi")]], []))),
      );

      expect(Array.from(stored.entries.values(), (entry) => texts(entry.messages))).toEqual([
        ["go", "assistant"],
        ["after"],
      ]);
      expect((yield* session.turns)[0]?.entries).toHaveLength(2);
    }),
  );

  it.effect("commits nothing for an Incomplete Step", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      const incomplete = [text("partial"), finish("length")] as const;
      const failed = yield* Effect.exit(
        session.run(
          Effect.gen(function* () {
            yield* user("dropped");
            expect((yield* step())._tag).toBe("Incomplete");
            return yield* Effect.fail("gave up");
          }).pipe(Effect.provide(scriptedModel([incomplete], []))),
        ),
      );
      expect(Exit.isFailure(failed)).toBe(true);
      expect(yield* session.history).toEqual([]);

      yield* session.run(
        Effect.gen(function* () {
          yield* user("kept");
          expect((yield* step())._tag).toBe("Incomplete");
        }).pipe(Effect.provide(scriptedModel([incomplete], []))),
      );
      // Only the prompt, at the program's end; the incomplete response was never staged.
      expect(texts(yield* session.history)).toEqual(["kept"]);
      expect((yield* session.turns).map((turn) => turn.entries.length)).toEqual([0, 1]);
    }),
  );

  it.effect("fails a Step whose commit wrote nothing and keeps the Session usable", () =>
    Effect.gen(function* () {
      let refuse = 1;
      const { transcript, stored } = recordingTranscript(() =>
        refuse-- > 0 ? Effect.fail(notWritten) : Effect.void,
      );
      const session = yield* Session.make({ transcript });
      const failed = yield* Effect.flip(
        session.run(
          Effect.andThen(user("go"), step()).pipe(Effect.provide(scriptedModel([[text("a")]], []))),
        ),
      );
      expect(failed).toBe(notWritten);
      expect(yield* session.history).toEqual([]);
      expect(stored.entries.size).toBe(0);
      expect((yield* session.turns)[0]).toMatchObject({ phase: "failed", entries: [] });

      // Not published, so still staged: a program that handles the failure commits them at its end.
      refuse = 1;
      yield* session.run(
        Effect.gen(function* () {
          yield* user("retry");
          expect(yield* Effect.flip(step())).toBe(notWritten);
        }).pipe(Effect.provide(scriptedModel([[text("b")]], []))),
      );
      expect(texts(yield* session.history)).toEqual(["retry", "assistant"]);
      expect(stored.entries.size).toBe(1);
    }),
  );

  it.effect("fences the Session when a Step's commit outcome is unknown", () =>
    Effect.gen(function* () {
      const { transcript, stored } = recordingTranscript(() =>
        Effect.fail(new SessionSaveError({ outcome: "unknown" })),
      );
      const session = yield* Session.make({ transcript });
      const failed = yield* Effect.flip(
        session.run(
          Effect.gen(function* () {
            yield* user("go");
            // A program that handles the failure cannot commit again: the Session is fenced.
            expect(yield* Effect.flip(step())).toMatchObject({ outcome: "unknown" });
            yield* user("more");
          }).pipe(Effect.provide(scriptedModel([[text("a")]], []))),
        ),
      );
      expect(failed).toBeInstanceOf(SessionFencedError);
      expect((yield* session.turns)[0]).toMatchObject({ phase: "uncertain", entries: [] });
      expect(yield* session.history).toEqual([]);
      expect(stored.entries.size).toBe(0);
      expect(yield* Effect.flip(session.run(user("again")))).toBeInstanceOf(SessionFencedError);
      expect(yield* Effect.flip(session.moveTo(undefined))).toBeInstanceOf(SessionFencedError);
    }),
  );

  it.effect("opens on a stored Transcript at its stored Branch and position", () =>
    Effect.gen(function* () {
      const { transcript, stored } = recordingTranscript();
      const entries: ReadonlyArray<Session.Entry> = [
        { id: "a", parent: undefined, messages: [message("root")] },
        { id: "b", parent: "a", messages: [message("chosen")] },
        { id: "c", parent: "a", messages: [message("sibling")] },
      ];
      for (const entry of entries) {
        stored.entries.set(entry.id, entry);
      }
      stored.position = "b";
      const session = yield* Session.make({ transcript });

      expect(texts(yield* session.history)).toEqual(["root", "chosen"]);
      expect(yield* session.position).toBe("b");
      yield* session.run(user("next"));
      const position = yield* session.position;
      expect(stored.entries.get(position ?? "")?.parent).toBe("b");
      expect(texts(yield* session.history)).toEqual(["root", "chosen", "next"]);
    }),
  );

  it.effect("continues a Transcript in a second Session and fences the stale first one", () =>
    Effect.gen(function* () {
      const { transcript, stored } = recordingTranscript();
      const first = yield* Session.make({ transcript });
      yield* first.run(user("one"));
      const second = yield* Session.make({ transcript });
      expect(texts(yield* second.history)).toEqual(["one"]);
      expect(yield* second.position).toBe(yield* first.position);
      yield* second.run(user("two"));
      expect(stored.entries.size).toBe(2);

      // The first Session's view is stale: its commit is refused, stores nothing and fences it.
      expect(yield* Effect.flip(first.run(user("stale")))).toMatchObject({ outcome: "conflict" });
      expect((yield* first.turns)[1]).toMatchObject({ phase: "uncertain", entries: [] });
      expect(yield* Effect.flip(first.run(user("again")))).toBeInstanceOf(SessionFencedError);
      expect(stored.entries.size).toBe(2);
      const third = yield* Session.make({ transcript });
      expect(texts(yield* third.history)).toEqual(["one", "two"]);
    }),
  );

  it.effect("names the Transcript it keeps its History tree in", () =>
    Effect.gen(function* () {
      const { transcript } = recordingTranscript();
      expect((yield* Session.make({ transcript })).transcript).toBe(transcript.id);
      // An in-memory one has its own id too, though nothing can open it again.
      const first = yield* Session.make({ transcript: "none" });
      const second = yield* Session.make({ transcript: "none" });
      expect(first.transcript).toEqual(expect.any(String));
      expect(first.transcript).not.toBe(second.transcript);
    }),
  );

  it.effect("fails to open when the Transcript cannot be read", () =>
    Effect.gen(function* () {
      const { transcript } = recordingTranscript();
      const unreadable = new TranscriptError({ detail: "unreadable" });
      const failed = yield* Effect.flip(
        Session.make({ transcript: { ...transcript, open: Effect.fail(unreadable) } }),
      );
      expect(failed).toBe(unreadable);
    }),
  );
});

describe("a staged Message", () => {
  const result = <A>(value: A) =>
    Prompt.toolMessage({
      content: [
        Prompt.toolResultPart({
          id: "call",
          name: "tool",
          isFailure: false,
          providerExecuted: false,
          result: value,
        }),
      ],
    });

  // A result of `undefined` counts as absent, and the Message then cannot be decoded.
  const unreadable = Effect.gen(function* () {
    const turn = yield* Turn;
    yield* turn.stage(message("kept"), result(undefined));
  });

  it.effect(
    "is refused when it does not read back without its absent fields, with no Transcript",
    () =>
      Effect.gen(function* () {
        const session = yield* Session.make({ transcript: "none" });
        const exit = yield* Effect.exit(session.run(unreadable));
        expect(Exit.hasDies(exit)).toBe(true);
        expect(String(exit)).toContain("cannot be kept");
        expect(yield* session.history).toEqual([]);
      }),
  );

  it.effect("is refused the same way with a Transcript, before anything is stored", () =>
    Effect.gen(function* () {
      const { transcript, stored } = recordingTranscript();
      const session = yield* Session.make({ transcript });
      const exit = yield* Effect.exit(session.run(unreadable));
      expect(Exit.hasDies(exit)).toBe(true);
      expect(String(exit)).toContain("cannot be kept");
      expect(stored.entries.size).toBe(0);
    }),
  );

  it.effect("is kept as a store would read it back, with no store too", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      yield* session.run(
        Effect.gen(function* () {
          const turn = yield* Turn;
          yield* turn.stage(result({ kept: "x", dropped: undefined }));
        }),
      );
      const [kept] = yield* session.history;
      expect(kept).toEqual(result({ kept: "x" }));
      expect(JSON.stringify(kept)).not.toContain("dropped");
    }),
  );
});

describe("SessionSaveError", () => {
  it("says why when the store gave a cause", () => {
    expect(
      new SessionSaveError({ outcome: "not-written", cause: new Error("disk full") }).message,
    ).toBe("Session save failed without writing: disk full");
    expect(new SessionSaveError({ outcome: "not-written", cause: "disk full" }).message).toBe(
      "Session save failed without writing: disk full",
    );
    expect(new SessionSaveError({ outcome: "unknown" }).message).toBe(
      "Session save outcome is unknown",
    );
  });
});

describe("staging while a Turn ends", () => {
  it.effect("keeps a batch whose staging succeeded, or refuses it as the Turn is closed", () =>
    Effect.gen(function* () {
      const outer = yield* Scope.make();
      const session = yield* Session.make({ transcript: "none" });
      const batch = Array.from({ length: 3000 }, (_, index) => message(`m${index}`));
      // Staged from a fiber that outlives the program: the Turn can end while the batch is checked.
      const staging = yield* session.run(
        Effect.gen(function* () {
          const turn = yield* Turn;
          return yield* Effect.forkIn(turn.stage(...batch), outer, { startImmediately: true });
        }),
      );
      const exit = yield* Fiber.await(staging);
      const kept = (yield* session.history).length;
      expect(Exit.isSuccess(exit) ? kept : "refused").toBe(Exit.isSuccess(exit) ? 3000 : "refused");
      if (Exit.isFailure(exit)) {
        expect(String(exit)).toContain("Turn is closed");
      }
      yield* Scope.close(outer, Exit.void);
    }),
  );
});

describe("Session.moveTo", () => {
  it.effect("branches the next Turn from an earlier Entry and keeps the old Branch", () =>
    Effect.gen(function* () {
      const { transcript, stored } = recordingTranscript();
      const session = yield* Session.make({ transcript });
      yield* session.run(user("one"));
      const one = yield* session.position;
      yield* session.run(user("two"));
      const two = yield* session.position;

      yield* session.moveTo(one);
      expect(texts(yield* session.history)).toEqual(["one"]);
      expect(yield* session.position).toBe(one);
      expect(stored.position).toBe(one);
      yield* session.run(user("other"));
      const other = yield* session.position;
      expect(texts(yield* session.history)).toEqual(["one", "other"]);
      expect(yield* session.tree).toEqual([
        { id: one, parent: undefined },
        { id: two, parent: one },
        { id: other, parent: one },
      ]);

      yield* session.moveTo(undefined);
      expect(yield* session.history).toEqual([]);
      yield* session.run(user("fresh"));
      expect(texts(yield* session.history)).toEqual(["fresh"]);
      expect((yield* session.tree).filter((entry) => entry.parent === undefined)).toHaveLength(2);
    }),
  );

  it.effect("refuses a missing Entry and leaves the Session where it was", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      yield* session.run(user("one"));
      const position = yield* session.position;

      expect(yield* Effect.flip(session.moveTo("missing"))).toBeInstanceOf(TranscriptError);
      expect(yield* session.position).toBe(position);
      yield* session.run(user("two"));
      expect(texts(yield* session.history)).toEqual(["one", "two"]);
    }),
  );

  it.effect("is refused while a Turn runs", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      yield* session.run(user("one"));
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const active = yield* Effect.forkChild(
        session.run(Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(gate))),
      );
      yield* Deferred.await(started);

      expect(yield* Effect.flip(session.moveTo(undefined))).toBeInstanceOf(SessionBusyError);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(active);
      expect(texts(yield* session.history)).toEqual(["one"]);
    }),
  );
});
