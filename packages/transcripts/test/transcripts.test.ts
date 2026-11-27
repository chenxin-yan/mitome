// jsonlTranscripts on real temporary directories. Each `Effect.provide(jsonlTranscripts(...))`
// builds its own Layer, standing in for a process that starts again or runs beside another.
import { spawnSync } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { afterAll } from "vite-plus/test";
import { Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Prompt } from "effect/ai";
import { Agent, SessionSaveError, Session, TranscriptError, Transcripts, Turn } from "@mitome/core";
import { jsonlTranscripts } from "../src/jsonl.js";

const temporary: Array<string> = [];
afterAll(() => Promise.all(temporary.map((path) => rm(path, { recursive: true, force: true }))));

const directory = Effect.promise(async () => {
  const made = await mkdtemp(join(tmpdir(), "mitome-transcripts-"));
  temporary.push(made);
  return made;
});

/** Stages its input as a user Message and returns it: a whole Turn without a Model. */
const echo = Agent.make({
  program: (input: string) =>
    Effect.gen(function* () {
      const turn = yield* Turn;
      yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: input })] }));
      return input;
    }),
});

const texts = (messages: ReadonlyArray<Prompt.Message>) =>
  messages.map((message) =>
    message.role === "user" && message.content[0]?.type === "text" ? message.content[0].text : "",
  );

/** A Session of `echo` on the conversation `selection` names, through a Layer of its own. */
const session = (at: string, selection: NonNullable<Session.SessionOptions["transcript"]>) =>
  Session.make(echo, { transcript: selection }).pipe(
    Effect.provide(jsonlTranscripts({ directory: at })),
  );

const service = (at: string) =>
  Effect.flatMap(Transcripts, (transcripts) =>
    transcripts === undefined
      ? Effect.die(new Error("no Transcripts"))
      : Effect.succeed(transcripts),
  ).pipe(Effect.provide(jsonlTranscripts({ directory: at })));

const file = (at: string, id: string) => join(at, `${id}.jsonl`);

describe("jsonlTranscripts", () => {
  it.live("keeps a conversation across a restart, at its Branch and position", () =>
    Effect.gen(function* () {
      const at = yield* directory;
      const first = yield* session(at, { create: "/work" });
      yield* first.run("one");
      yield* first.run("two");

      const restarted = yield* session(at, { latest: "/work" });
      expect(restarted.transcript).toBe(first.transcript);
      expect(texts(yield* restarted.history)).toEqual(["one", "two"]);
      expect(yield* restarted.position).toBe(yield* first.position);
      yield* restarted.run("three");
      const byId = yield* session(at, { open: first.transcript });
      expect(texts(yield* byId.history)).toEqual(["one", "two", "three"]);
    }),
  );

  it.live("keeps both continuations after a move to an earlier Entry", () =>
    Effect.gen(function* () {
      const at = yield* directory;
      const writer = yield* session(at, { create: "/work" });
      yield* writer.run("one");
      const one = yield* writer.position;
      yield* writer.run("two");
      const two = yield* writer.position;
      yield* writer.moveTo(one);
      yield* writer.run("other");
      const other = yield* writer.position;

      const reopened = yield* session(at, { open: writer.transcript });
      expect(texts(yield* reopened.history)).toEqual(["one", "other"]);
      expect(yield* reopened.position).toBe(other);
      expect(yield* reopened.tree).toEqual([
        { id: one, parent: undefined },
        { id: two, parent: one },
        { id: other, parent: one },
      ]);
    }),
  );

  it.live("refuses a second writer's stale commit and overwrites nothing", () =>
    Effect.gen(function* () {
      const at = yield* directory;
      const first = yield* session(at, { create: "/work" });
      yield* first.run("one");
      const second = yield* session(at, { latest: "/work" });
      yield* second.run("two");

      const refused = yield* Effect.flip(first.run("stale"));
      expect(refused).toBeInstanceOf(SessionSaveError);
      expect(refused).toMatchObject({ outcome: "conflict" });
      const reopened = yield* session(at, { open: first.transcript });
      expect(texts(yield* reopened.history)).toEqual(["one", "two"]);
      expect(yield* reopened.tree).toHaveLength(2);
      expect(
        yield* Effect.promise(() => readFile(file(at, first.transcript), "utf8")),
      ).not.toContain("stale");
    }),
  );

  it.live("ignores an incomplete last line and overwrites it with the next append", () =>
    Effect.gen(function* () {
      const at = yield* directory;
      const writer = yield* session(at, { create: "/work" });
      yield* writer.run("one");
      const path = file(at, writer.transcript);
      // A crash during an append: the line never got its newline.
      const torn = '{"type":"entry","id":"torn","parent":null,"messa';
      yield* Effect.promise(() => appendFile(path, torn));

      const reopened = yield* session(at, { open: writer.transcript });
      expect(texts(yield* reopened.history)).toEqual(["one"]);
      yield* reopened.run("two");
      const contents = yield* Effect.promise(() => readFile(path, "utf8"));
      expect(contents).not.toContain(torn);
      expect(contents.endsWith("\n")).toBe(true);
      expect(texts(yield* (yield* session(at, { latest: "/work" })).history)).toEqual([
        "one",
        "two",
      ]);
    }),
  );

  it.live("fails to open an unknown version or a malformed complete line", () =>
    Effect.gen(function* () {
      const at = yield* directory;
      const id = crypto.randomUUID();
      const header = (version: number) =>
        `${JSON.stringify({ version, id, scope: "/work", created: "2026-11-24T00:00:00.000Z" })}\n`;
      for (const [contents, detail] of [
        [header(2), "has version 2"],
        [`${header(1)}not json\n`, "line 2 is malformed"],
        [`${header(1)}{"type":"position","position":"missing"}\n`, "line 2 is malformed"],
      ] as const) {
        yield* Effect.promise(() => writeFile(file(at, id), contents));
        const failed = yield* Effect.flip(Effect.scoped(session(at, { open: id })));
        expect(failed).toBeInstanceOf(TranscriptError);
        expect(failed.message).toContain(detail);
      }
    }),
  );

  it.live("waits for another writer's lock, and an interrupted wait leaves it alone", () =>
    Effect.gen(function* () {
      const at = yield* directory;
      const transcript = yield* (yield* service(at)).create("/work");
      const entry = (id: string) => ({ id, parent: undefined, messages: [] });
      const lock = join(at, `${transcript.id}.lock`);
      yield* transcript.append(entry("first"), undefined);
      // Another writer holds the lock.
      yield* Effect.promise(() => writeFile(lock, ""));
      const waiting = yield* Effect.forkChild(transcript.append(entry("second"), "first"));
      yield* Effect.sleep(50);
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(waiting);
      expect(yield* Effect.promise(() => readdir(at))).toContain(`${transcript.id}.lock`);

      yield* Effect.promise(() => rm(lock));
      yield* transcript.append(entry("second"), "first");
      expect(yield* Effect.promise(() => readdir(at))).toEqual([`${transcript.id}.jsonl`]);
      expect((yield* transcript.open).position).toBe("second");
    }),
  );

  it.effect("names the lock it gave up waiting for", () =>
    Effect.gen(function* () {
      const at = yield* directory;
      const transcript = yield* (yield* service(at)).create("/work");
      const lock = join(at, `${transcript.id}.lock`);
      yield* Effect.promise(() => writeFile(lock, ""));
      const waiting = yield* Effect.forkChild(
        Effect.flip(transcript.append({ id: "first", parent: undefined, messages: [] }, undefined)),
      );
      // The wait reads real files between its sleeps, so the clock moves until it has given up.
      while (waiting.pollUnsafe() === undefined) {
        yield* TestClock.adjust("1 second");
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
      }
      const refused = yield* Fiber.join(waiting);
      expect(refused).toMatchObject({ _tag: "SessionSaveError", outcome: "not-written" });
      expect(refused.message).toContain(lock);
    }),
  );

  it.live("refuses, writing nothing, an Entry it could not read back", () =>
    Effect.gen(function* () {
      const at = yield* directory;
      const transcript = yield* (yield* service(at)).create("/work");
      const said = Prompt.userMessage({ content: [Prompt.textPart({ text: "one" })] });
      yield* transcript.append({ id: "first", parent: undefined, messages: [said] }, undefined);
      const before = yield* Effect.promise(() => readFile(file(at, transcript.id), "utf8"));
      const toolResult = <A>(result: A) =>
        Prompt.toolMessage({
          content: [
            Prompt.toolResultPart({
              id: "call",
              name: "tool",
              isFailure: false,
              providerExecuted: false,
              result,
            }),
          ],
        });
      class Stamp {
        toJSON() {
          return "stamp";
        }
      }
      for (const entry of [
        // A Tool result of `undefined` is not plain data.
        { id: "second", parent: "first", messages: [toolResult(undefined)] },
        // Not plain data.
        {
          id: "second",
          parent: "first",
          messages: [toolResult({ reading: Number.NaN, values: new Set(["one", "two"]) })],
        },
        { id: "second", parent: "first", messages: [toolResult(new Stamp())] },
        // A field of `undefined` is not JSON; a Session drops it before an Entry gets here.
        { id: "second", parent: "first", messages: [toolResult({ gone: undefined })] },
        { id: "first", parent: "first", messages: [said] },
        { id: "second", parent: "missing", messages: [said] },
      ]) {
        const refused = yield* Effect.flip(transcript.append(entry, "first"));
        expect(refused).toBeInstanceOf(SessionSaveError);
        expect(refused).toMatchObject({ outcome: "not-written" });
        // It says why, so that whoever reads the failure can act on it.
        expect(refused.message.length).toBeGreaterThan(
          "Session save failed without writing".length,
        );
      }
      expect(yield* Effect.promise(() => readFile(file(at, transcript.id), "utf8"))).toBe(before);
      const reopened = yield* session(at, { open: transcript.id });
      expect(texts(yield* reopened.history)).toEqual(["one"]);
    }),
  );

  it.live("keeps of a plain value appended directly what JSON keeps of it", () =>
    Effect.gen(function* () {
      const at = yield* directory;
      const transcript = yield* (yield* service(at)).create("/work");
      // Plain data, which JSON writes with -0 as 0.
      const result = { reading: -0, kept: ["one"] };
      yield* transcript.append(
        {
          id: "first",
          parent: undefined,
          messages: [
            Prompt.toolMessage({
              content: [
                Prompt.toolResultPart({
                  id: "call",
                  name: "tool",
                  isFailure: false,
                  providerExecuted: false,
                  result,
                }),
              ],
            }),
          ],
        },
        undefined,
      );
      const [entry] = (yield* transcript.open).branch;
      const [part] = entry?.messages[0]?.role === "tool" ? entry.messages[0].content : [];
      const kept = part?.type === "tool-result" ? part.result : undefined;
      expect(kept).toStrictEqual({ reading: 0, kept: ["one"] });
    }),
  );

  it.live("finds the latest conversation from headers alone, past files it cannot use", () =>
    Effect.gen(function* () {
      const at = yield* directory;
      const healthy = yield* session(at, { create: "/a" });
      yield* healthy.run("kept");
      const header = (id: string, scope: string) =>
        `${JSON.stringify({ version: 1, id, scope, created: "2026-11-24T00:00:00.000Z" })}\n`;
      // Newer files: another scope's with a body that is not UTF-8, and one whose header is no JSON.
      const broken = crypto.randomUUID();
      const garbled = crypto.randomUUID();
      yield* Effect.promise(async () => {
        await writeFile(
          file(at, broken),
          Buffer.concat([Buffer.from(header(broken, "/b")), Buffer.from([0xff, 0x0a])]),
        );
        await writeFile(file(at, garbled), "not json\n");
        await utimes(file(at, healthy.transcript), 1, 1);
      });
      const transcripts = yield* service(at);
      expect((yield* transcripts.latest("/a"))?.id).toBe(healthy.transcript);
      // The body is checked when the chosen conversation is opened.
      expect((yield* transcripts.latest("/b"))?.id).toBe(broken);
      expect(yield* Effect.flip(Effect.scoped(session(at, { latest: "/b" })))).toBeInstanceOf(
        TranscriptError,
      );
    }),
  );

  it.live("finds a conversation by a header longer than one read", () =>
    Effect.gen(function* () {
      const at = yield* directory;
      // Two-byte characters, so some fall across the boundary between two reads.
      const scope = `/${"é".repeat(5_000)}`;
      const writer = yield* session(at, { create: scope });
      yield* writer.run("kept");
      expect((yield* (yield* service(at)).latest(scope))?.id).toBe(writer.transcript);
    }),
  );

  it.live("finds the latest conversation per scope, and no missing one", () =>
    Effect.gen(function* () {
      const at = yield* directory;
      const ids: Array<string> = [];
      for (const scope of ["/a", "/a", "/b"]) {
        const writer = yield* session(at, { create: scope });
        yield* writer.run(scope);
        ids.push(writer.transcript);
      }
      const [older, newer, other] = ids;
      // Written is the file's modification time: make the older one /a's most recently written.
      yield* Effect.promise(async () => {
        await utimes(file(at, newer ?? ""), 1, 1);
        await utimes(file(at, other ?? ""), 2, 2);
      });
      const transcripts = yield* service(at);
      expect((yield* transcripts.latest("/a"))?.id).toBe(older);
      expect((yield* transcripts.latest("/b"))?.id).toBe(other);
      expect(yield* transcripts.latest("/c")).toBeUndefined();
      expect(yield* transcripts.open(crypto.randomUUID())).toBeUndefined();
      expect(yield* transcripts.open("../outside")).toBeUndefined();
      // A conversation that was created but never written does not exist yet.
      const created = yield* transcripts.create("/d");
      expect(yield* transcripts.open(created.id)).toBeUndefined();
      expect(yield* transcripts.latest("/d")).toBeUndefined();
    }),
  );

  it.live.skipIf(process.platform === "win32")(
    "creates the directory and each file readable by their owner only",
    () =>
      Effect.gen(function* () {
        const at = join(yield* directory, "state", "transcripts");
        const writer = yield* session(at, { create: "/work" });
        yield* writer.run("private");
        const modes = yield* Effect.promise(async () => [
          (await stat(at)).mode & 0o777,
          (await stat(file(at, writer.transcript))).mode & 0o777,
        ]);
        expect(modes).toEqual([0o700, 0o600]);
      }),
  );

  it.live("keeps conversations in the state directory by default, and needs one", () =>
    Effect.gen(function* () {
      const home = yield* directory;
      const saved = { ...process.env };
      const restore = Effect.sync(() => {
        for (const name of ["MITOME_HOME", "XDG_STATE_HOME", "LOCALAPPDATA", "HOME"]) {
          if (saved[name] === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = saved[name];
          }
        }
      });
      yield* Effect.gen(function* () {
        for (const name of ["MITOME_HOME", "XDG_STATE_HOME", "LOCALAPPDATA", "HOME"]) {
          delete process.env[name];
        }
        const unbuilt = yield* Effect.exit(Layer.build(jsonlTranscripts()));
        expect(Exit.isFailure(unbuilt) ? String(unbuilt.cause) : "built").toContain(
          "Set MITOME_HOME, XDG_STATE_HOME",
        );

        process.env.MITOME_HOME = home;
        const writer = yield* Session.make(echo).pipe(Effect.provide(jsonlTranscripts()));
        yield* writer.run("kept");
        yield* Effect.promise(() => stat(join(home, "transcripts", `${writer.transcript}.jsonl`)));
      }).pipe(Effect.ensuring(restore));
    }),
  );
});

// Each of these starts a process that loads Effect and the built packages cold, which takes seconds
// on a loaded machine: hence the longer limit.
describe("jsonlTranscripts as built", () => {
  it(
    "refuses a live value when staged and reopens plain data as the Session itself holds it",
    { tags: ["dist"], timeout: 30_000 },
    async () => {
      const at = await mkdtemp(join(tmpdir(), "mitome-transcripts-"));
      temporary.push(at);
      const built = new URL("../dist/jsonl.js", import.meta.url).href;
      const core = new URL("../node_modules/@mitome/core/dist/index.js", import.meta.url).href;
      const kernel = new URL("../node_modules/@mitome/core/dist/kernel.js", import.meta.url).href;
      // The conversation holds plain data: a live value is refused when staged, before the store
      // sees it, and plain data reopens as the live Session holds it. JSON would drop a field of
      // `undefined` and the sign of -0; the Session has already, so the two histories agree.
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const { isDeepStrictEqual } = await import("node:util");
const { Effect, Exit } = await import(${JSON.stringify(import.meta.resolve("effect"))});
const { Prompt } = await import(${JSON.stringify(import.meta.resolve("effect/ai"))});
const { Transcripts, Turn } = await import(${JSON.stringify(core)});
const { Session } = await import(${JSON.stringify(kernel)});
const { jsonlTranscripts } = await import(${JSON.stringify(built)});
const session = (select) => Effect.gen(function* () {
  const transcript = yield* select(yield* Transcripts);
  return yield* Session.make({ transcript });
}).pipe(Effect.provide(jsonlTranscripts({ directory: ${JSON.stringify(at)} })));
const stage = (result) => Effect.flatMap(Turn, (turn) => turn.stage(
  Prompt.assistantMessage({ content: [Prompt.toolCallPart({ id: "call", name: "read", params: {}, providerExecuted: false })] }),
  Prompt.toolMessage({ content: [Prompt.toolResultPart({ id: "call", name: "read", isFailure: false, providerExecuted: false, result })] }),
));
const reopen = (id) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  return yield* (yield* session((transcripts) => transcripts.open(id))).history;
})));
// How many Entries the store holds for a conversation; one never written has none.
const storedEntries = (id) => Effect.runPromise(Effect.gen(function* () {
  const transcript = yield* (yield* Transcripts).open(id);
  return transcript === undefined ? 0 : (yield* transcript.open).branch.length;
}).pipe(Effect.provide(jsonlTranscripts({ directory: ${JSON.stringify(at)} }))));
const refused = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const writer = yield* session((transcripts) => transcripts.create("/work"));
  const exit = yield* Effect.exit(writer.run(stage({ reading: Number.NaN, values: new Set(["one"]) })));
  return { id: writer.transcript, died: Exit.hasDies(exit), history: yield* writer.history };
})));
const live = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const writer = yield* session((transcripts) => transcripts.create("/work"));
  yield* writer.run(stage({ reading: -0, values: ["one"], gone: undefined }));
  return { id: writer.transcript, history: yield* writer.history };
})));
const reopened = await reopen(live.id);
console.log(JSON.stringify({
  refused: refused.died && refused.history.length === 0 && (await storedEntries(refused.id)) === 0,
  same: isDeepStrictEqual(live.history, reopened),
  dropped: !Object.hasOwn(live.history[1].content[0].result, "gone"),
  zero: Object.is(live.history[1].content[0].result.reading, 0),
}));`,
        ],
        { encoding: "utf8" },
      );
      expect(child.stderr).toBe("");
      expect(JSON.parse(child.stdout)).toEqual({
        refused: true,
        same: true,
        dropped: true,
        zero: true,
      });
    },
  );

  // A umask applies only to POSIX modes, and only a process of its own can change it.
  // 0o477 takes the owner's read permission away from what the process creates, 0o277 its write.
  for (const umask of [0o477, 0o277]) {
    it.skipIf(process.platform === "win32")(
      `keeps directories and files usable by their owner alone under umask ${umask.toString(8)}`,
      { tags: ["dist"], timeout: 30_000 },
      async () => {
        const root = await mkdtemp(join(tmpdir(), "mitome-transcripts-"));
        temporary.push(root);
        // The state directory is missing too, so this call creates both.
        const state = join(root, "state");
        const at = join(state, "transcripts");
        const built = new URL("../dist/jsonl.js", import.meta.url).href;
        const core = new URL("../node_modules/@mitome/core/dist/index.js", import.meta.url).href;
        const effect = import.meta.resolve("effect");
        const child = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `process.umask(${umask});
const { Effect } = await import(${JSON.stringify(effect)});
const { Transcripts } = await import(${JSON.stringify(core)});
const { jsonlTranscripts } = await import(${JSON.stringify(built)});
await Effect.runPromise(Effect.gen(function* () {
  const transcript = yield* (yield* Transcripts).create("/work");
  yield* transcript.append({ id: "e", parent: undefined, messages: [] }, undefined);
  console.log(transcript.id);
}).pipe(Effect.provide(jsonlTranscripts({ directory: ${JSON.stringify(at)} }))));`,
          ],
          { encoding: "utf8" },
        );
        expect(child.stderr).toBe("");
        expect(child.status).toBe(0);
        const path = join(at, `${child.stdout.trim()}.jsonl`);
        expect((await stat(state)).mode & 0o777).toBe(0o700);
        expect((await stat(at)).mode & 0o777).toBe(0o700);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(await readFile(path, "utf8")).toContain('{"type":"entry","id":"e","parent":null');
      },
    );
  }
});
