import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";
import { Prompt, Tool, Toolkit } from "effect/ai";
import {
  Agent,
  Command,
  Extension,
  Mitome,
  Session,
  TranscriptSelectionError,
  Transcripts,
  type TranscriptsService,
  Turn,
} from "../../src/index.js";
import { call, finish, scriptedModel, text } from "../support/step.js";
import { recordingTranscript } from "../support/transcript.js";

/** A selector as a consumer compiling without `exactOptionalPropertyTypes` sees it. */
interface LooseSelection {
  readonly create?: string | undefined;
  readonly latest?: string | undefined;
  readonly open?: string | undefined;
}

/** A Transcripts service over recording Transcripts; `log` records each call. */
const transcripts = (log: Array<string>) => {
  const byId = new Map<string, ReturnType<typeof recordingTranscript>>();
  const latest = new Map<string, string>();
  const service: TranscriptsService = {
    create: (scope) =>
      Effect.sync(() => {
        log.push(`create:${scope}`);
        const id = `t${byId.size}`;
        const made = recordingTranscript();
        const transcript = { ...made.transcript, id };
        byId.set(id, { ...made, transcript });
        latest.set(scope, id);
        return transcript;
      }),
    latest: (scope) =>
      Effect.sync(() => {
        log.push(`latest:${scope}`);
        const id = latest.get(scope);
        return id === undefined ? undefined : byId.get(id)?.transcript;
      }),
    open: (id) =>
      Effect.sync(() => {
        log.push(`open:${id}`);
        return byId.get(id)?.transcript;
      }),
  };
  return { service, byId };
};

const texts = (messages: ReadonlyArray<Prompt.Message>) =>
  messages.map((entry) =>
    entry.role === "user" && entry.content[0]?.type === "text" ? entry.content[0].text : entry.role,
  );

/** Stages its input and returns it: a whole Turn without a Model. */
const echo = Agent.make({
  program: (input: string) =>
    Effect.gen(function* () {
      const turn = yield* Turn;
      yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: input })] }));
      return input;
    }),
});

describe("Session.make(agent) with Transcripts", () => {
  it.effect("keeps the conversation in the caller's Transcripts, a new one by default", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const { service, byId } = transcripts(log);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* Session.make(echo);
          expect(first.transcript).toBe("t0");
          yield* first.run("one");
          expect(byId.get("t0")?.stored.entries.size).toBe(1);

          const latest = yield* Session.make(echo, { transcript: { latest: "" } });
          expect(texts(yield* latest.history)).toEqual(["one"]);
          yield* latest.run("two");

          const opened = yield* Session.make(echo, { transcript: { open: "t0" } });
          expect(opened.transcript).toBe("t0");
          expect(texts(yield* opened.history)).toEqual(["one", "two"]);
          expect(yield* opened.position).toBe(byId.get("t0")?.stored.position);

          const scoped = yield* Session.make(echo, { transcript: { create: "/work" } });
          expect(scoped.transcript).toBe("t1");
          expect(yield* scoped.history).toEqual([]);
        }).pipe(Effect.provideService(Transcripts, service)),
      );
      expect(log).toEqual(["create:", "latest:", "open:t0", "create:/work"]);
      expect(byId.get("t0")?.stored.entries.size).toBe(2);
    }),
  );

  it.effect("fails a request for a stored conversation it cannot have", () =>
    Effect.gen(function* () {
      for (const transcript of [{ latest: "here" }, { open: "t0" }]) {
        const failed = yield* Effect.flip(Effect.scoped(Session.make(echo, { transcript })));
        expect(failed).toBeInstanceOf(TranscriptSelectionError);
        expect(failed).toMatchObject({ reason: "no-store" });
      }
      const { service } = transcripts([]);
      for (const transcript of [{ latest: "here" }, { open: "missing" }]) {
        const failed = yield* Effect.flip(
          Effect.scoped(Session.make(echo, { transcript })).pipe(
            Effect.provideService(Transcripts, service),
          ),
        );
        expect(failed).toMatchObject({ _tag: "TranscriptSelectionError", reason: "not-found" });
      }
      // Without the service a new conversation is kept in memory.
      const history = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(echo, { transcript: { create: "here" } });
          yield* session.run("kept");
          return yield* session.history;
        }),
      );
      expect(texts(history)).toEqual(["kept"]);
    }),
  );

  it.effect("treats a selector given as undefined as absent", () =>
    Effect.gen(function* () {
      // SAFETY: deliberately what a consumer compiling without `exactOptionalPropertyTypes` can
      // write: an alternative's other keys present with the value `undefined`.
      const mixed = (transcript: LooseSelection) => ({ transcript }) as never;
      for (const transcript of [
        { create: undefined, open: "saved" },
        { latest: undefined, open: "saved" },
        { open: undefined, latest: "here" },
      ]) {
        const failed = yield* Effect.flip(Effect.scoped(Session.make(echo, mixed(transcript))));
        expect(failed).toMatchObject({ _tag: "TranscriptSelectionError", reason: "no-store" });
      }
      const log: Array<string> = [];
      const { service } = transcripts(log);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* Session.make(echo);
          yield* first.run("one");
          const opened = yield* Session.make(echo, mixed({ create: undefined, open: "t0" }));
          expect(texts(yield* opened.history)).toEqual(["one"]);
          // The empty string stays a scope.
          yield* Session.make(echo, mixed({ create: "", open: undefined }));
        }).pipe(Effect.provideService(Transcripts, service)),
      );
      expect(log).toEqual(["create:", "open:t0", "create:"]);
    }),
  );

  it.effect("withholds Transcripts from the program, Extensions, Tools and Commands", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const { service } = transcripts(log);
      const seen: Array<string> = [];
      const probe = (where: string) =>
        Effect.gen(function* () {
          seen.push(`${where}:${(yield* Transcripts) === undefined ? "withheld" : "visible"}`);
        });
      const Peek = Tool.make("peek", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.String,
      });
      const PeekKit = Toolkit.make(Peek);
      const spy = Extension.make(
        "spy",
        Effect.as(probe("setup"), {
          tools: PeekKit,
          handlers: PeekKit.of({ peek: () => Effect.as(probe("handler"), "x") }),
          policy: () => Effect.as(probe("policy"), "allow" as const),
          commands: [
            Command.make("peek", {
              description: "Peek",
              run: () => Effect.as(probe("command"), Command.reply("")),
            }),
          ],
        }),
      );
      const agent = Agent.make({
        use: [spy],
        program: (input: string, { loop }) =>
          Effect.gen(function* () {
            yield* probe("program");
            const turn = yield* Turn;
            yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: input })] }));
            return (yield* loop).response.text;
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(agent);
          yield* session.run("go");
          yield* session.command("peek", "");
        }),
      ).pipe(
        Effect.provideService(Transcripts, service),
        Effect.provide(
          scriptedModel([[call("c1", "peek"), finish("tool-calls")], [text("done")]], []),
        ),
      );

      expect(log).toEqual(["create:"]);
      expect(seen).toEqual([
        "setup:withheld",
        "program:withheld",
        "policy:withheld",
        "handler:withheld",
        "command:withheld",
      ]);
    }),
  );
});

describe("Mitome.Instance sessions with Transcripts", () => {
  it.effect("take Transcripts from the Configuration's services", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const { service, byId } = transcripts(log);
      const app = Mitome.make({ agent: echo, provide: Layer.succeed(Transcripts, service) });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* app.acquire();
          const first = yield* instance.session();
          yield* first.run("one");
          const next = yield* instance.session({ transcript: { latest: "" } });
          expect(next.transcript).toBe(first.transcript);
          expect(first.transcript).toBe("t0");
          expect(texts(yield* next.history)).toEqual(["one"]);
          yield* next.run("two");
          yield* next.moveTo(undefined);
          expect(yield* next.history).toEqual([]);
          expect(yield* next.tree).toHaveLength(2);
        }),
      );
      expect(log).toEqual(["create:", "latest:"]);
      expect(byId.get("t0")?.stored.position).toBeUndefined();
    }),
  );

  it.effect(
    "keep history in memory when the Configuration has no store, whatever the caller has",
    () =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const { service } = transcripts(log);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const instance = yield* Mitome.make({ agent: echo }).acquire();
            const session = yield* instance.session();
            yield* session.run("kept");
            expect(texts(yield* session.history)).toEqual(["kept"]);
            const opened = yield* Effect.flip(instance.session({ transcript: { open: "t0" } }));
            expect(opened).toMatchObject({ _tag: "TranscriptSelectionError", reason: "no-store" });
          }),
        ).pipe(Effect.provideService(Transcripts, service));
        expect(log).toEqual([]);
      }),
  );

  it.effect("withhold Transcripts from the Agent's text mapping", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const probe = (where: string) =>
        Effect.gen(function* () {
          seen.push(`${where}:${(yield* Transcripts) === undefined ? "withheld" : "visible"}`);
        });
      const app = Mitome.make({
        agent: Agent.make({
          program: (input: string) => Effect.succeed(input.length),
          text: {
            parse: (value) => Effect.as(probe("parse"), value),
            render: (n) => Effect.as(probe("render"), `${n} characters`),
          },
        }),
        provide: Layer.succeed(Transcripts, transcripts([]).service),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* app.acquire();
          expect(yield* instance.provide(app.text.parse("hello"))).toBe("hello");
          expect(yield* instance.provide(app.text.render(5))).toBe("5 characters");
          // Host code run through the instance still has the store.
          const hostSees = Effect.gen(function* () {
            return (yield* Transcripts) !== undefined;
          });
          expect(yield* instance.provide(hostSees)).toBe(true);
        }),
      );
      expect(seen).toEqual(["parse:withheld", "render:withheld"]);
    }),
  );

  it.effect("withhold Transcripts from the text mapping's own synchronous code", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      // Code a callback runs before it returns its Effect, reading the fiber it is called on.
      const peek = (where: string) => {
        const context = Fiber.getCurrent()?.context;
        seen.push(
          `${where}:${context !== undefined && Context.get(context, Transcripts) !== undefined ? "visible" : "withheld"}`,
        );
      };
      const app = Mitome.make({
        agent: Agent.make({
          program: (input: string) => Effect.succeed(input.length),
          text: {
            parse: (value) => (peek("parse"), Effect.succeed(value)),
            render: (n) => (peek("render"), Effect.succeed(`${n} characters`)),
          },
        }),
        provide: Layer.succeed(Transcripts, transcripts([]).service),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* app.acquire();
          yield* instance.provide(
            Effect.suspend(() => Effect.andThen(app.text.parse("hello"), app.text.render(5))),
          );
        }),
      );
      expect(seen).toEqual(["parse:withheld", "render:withheld"]);
    }),
  );

  it.effect("settle a move and a tree read before shutdown releases the store", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const reading = yield* Deferred.make<void>();
      const made = recordingTranscript();
      const held: Session.Transcript = {
        ...made.transcript,
        select: (position, expected) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(made.transcript.select(position, expected)),
            Effect.ensuring(Effect.sync(() => void log.push("select settled"))),
          ),
        tree: Deferred.succeed(reading, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => void log.push("tree interrupted"))),
        ),
      };
      const store = Layer.effect(
        Transcripts,
        Effect.acquireRelease(
          Effect.succeed<TranscriptsService>({
            create: () => Effect.succeed(held),
            latest: () => Effect.succeed(undefined),
            open: () => Effect.succeed(undefined),
          }),
          () => Effect.sync(() => void log.push("store released")),
        ),
      );
      const instance = yield* Mitome.make({ agent: echo, provide: store })
        .acquire()
        .pipe(Effect.provideService(Scope.Scope, yield* Scope.make()));
      const session = yield* instance.session();
      yield* session.run("one");
      const read = yield* Effect.forkChild(session.tree);
      yield* Deferred.await(reading);
      const move = yield* Effect.forkChild(session.moveTo(undefined));
      yield* Deferred.await(entered);
      const shutdown = yield* Effect.forkChild(instance.shutdown, { startImmediately: true });
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;

      expect(shutdown.pollUnsafe()).toBeUndefined();
      expect(log).toEqual([]);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(shutdown);

      expect(log).toEqual(["select settled", "tree interrupted", "store released"]);
      expect(Exit.hasInterrupts(yield* Fiber.await(move))).toBe(true);
      expect(made.stored.position).toBeUndefined();
      void read;
    }),
  );
});
