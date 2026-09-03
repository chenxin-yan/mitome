import { expect, test } from "vitest";
import { Stream } from "effect";
import { Response } from "effect/unstable/ai";
import {
  defineAgent,
  memoryTranscripts,
  StoreError,
  TranscriptNotFound,
  TranscriptSchemaVersion,
  TurnError,
  withSession,
} from "../src/index.js";
import type { Transcript } from "../src/index.js";
import { makeTestProvider } from "./provider.js";

const textResponse = (text: string) =>
  Stream.fromIterable([
    Response.makePart("text-start", { id: "response" }),
    Response.makePart("text-delta", { id: "response", delta: text }),
    Response.makePart("text-end", { id: "response" }),
  ]);

const definitionWith = (run: Parameters<typeof makeTestProvider>[0]) =>
  defineAgent({
    providers: [makeTestProvider(run)],
    model: "test/default",
    extensions: [],
  });

test("adapts Promise Transcript store misses and rejections to tagged Core errors", async () => {
  const definition = definitionWith(() => textResponse("done"));
  const methods = {
    save: async () => undefined,
    list: async () => [],
    appendEvent: async () => undefined,
  };

  await expect(
    withSession(
      definition,
      { transcripts: { ...methods, load: async () => null }, resume: "missing" },
      async () => undefined,
    ),
  ).rejects.toEqual(new TranscriptNotFound({ id: "missing" }));

  const cause = new Error("database offline");
  await expect(
    withSession(
      definition,
      { transcripts: { ...methods, load: async () => Promise.reject(cause) }, resume: "seed" },
      async () => undefined,
    ),
  ).rejects.toMatchObject({ _tag: "StoreError", cause });
});

test("snapshots and resumes prior context through the public SDK", async () => {
  const store = memoryTranscripts();
  const prompts: Array<ReadonlyArray<string>> = [];
  const definition = definitionWith(({ prompt }) => {
    prompts.push(prompt.content.map((message) => message.role));
    return textResponse("hello");
  });

  const parentId = await withSession(definition, { transcripts: store }, async (session) => {
    await Array.fromAsync(session.runTurn("first"));
    return session.transcript().id;
  });
  const child = await withSession(
    definition,
    { transcripts: store, resume: parentId },
    async (session) => {
      await Array.fromAsync(session.runTurn("second"));
      return session.transcript();
    },
  );

  expect(prompts).toEqual([["user"], ["user", "assistant", "user"]]);
  expect(child.id).not.toBe(parentId);
  expect(child.parentTranscriptId).toBe(parentId);
  expect(await store.load(child.id)).toEqual(child);
});

test("two resumes create independent child Transcripts with parent provenance", async () => {
  const store = memoryTranscripts();
  const definition = definitionWith(() => textResponse("done"));
  const parentId = await withSession(definition, { transcripts: store }, async (session) => {
    await Array.fromAsync(session.runTurn("parent"));
    return session.transcript().id;
  });

  const resume = (text: string) =>
    withSession(definition, { transcripts: store, resume: parentId }, async (session) => {
      await Array.fromAsync(session.runTurn(text));
      return session.transcript();
    });
  const [first, second] = await Promise.all([resume("first fork"), resume("second fork")]);

  expect(first.id).not.toBe(second.id);
  expect(first.parentTranscriptId).toBe(parentId);
  expect(second.parentTranscriptId).toBe(parentId);
  expect(first.messages.at(-2)).toMatchObject({
    role: "user",
    content: [{ type: "text", text: "first fork" }],
  });
  expect(second.messages.at(-2)).toMatchObject({
    role: "user",
    content: [{ type: "text", text: "second fork" }],
  });
});

test("a hand-constructed Transcript seeds a Session", async () => {
  const synthetic: Transcript = {
    schemaVersion: TranscriptSchemaVersion,
    id: "synthetic",
    messages: [{ role: "user", content: [{ type: "text", text: "seed context" }] }],
  };
  let roles: ReadonlyArray<string> = [];
  const definition = definitionWith(({ prompt }) => {
    roles = prompt.content.map((message) => message.role);
    return textResponse("done");
  });

  const transcript = await withSession(definition, { transcript: synthetic }, async (session) => {
    await Array.fromAsync(session.runTurn("continue"));
    return session.transcript();
  });

  expect(roles).toEqual(["user", "user"]);
  expect(transcript.parentTranscriptId).toBe("synthetic");
});

test("a failed save surfaces StoreError but keeps the completed turn committed", async () => {
  const store = memoryTranscripts();
  const failing = {
    ...store,
    save: () => Promise.reject(new StoreError({ message: "disk full" })),
  };
  const roles: Array<ReadonlyArray<string>> = [];
  const definition = definitionWith(({ prompt }) => {
    roles.push(prompt.content.map((message) => message.role));
    return textResponse("done");
  });

  await withSession(definition, { transcripts: failing }, async (session) => {
    await expect(Array.fromAsync(session.runTurn("first"))).rejects.toBeInstanceOf(StoreError);
    expect(session.transcript().messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    await expect(Array.fromAsync(session.runTurn("second"))).rejects.toBeInstanceOf(StoreError);
  });

  expect(roles).toEqual([["user"], ["user", "assistant", "user"]]);
});

test("failed and interrupted Turns leave stored Transcripts unchanged", async () => {
  const store = memoryTranscripts();
  let calls = 0;
  const definition = definitionWith(() => {
    calls += 1;
    if (calls === 2) return Stream.fail(new Error("failed"));
    if (calls === 3) {
      return Stream.concat(
        Stream.succeed(Response.makePart("text-delta", { id: "partial", delta: "partial" })),
        Stream.never,
      );
    }
    return textResponse("saved");
  });

  const transcriptId = await withSession(definition, { transcripts: store }, async (session) => {
    await Array.fromAsync(session.runTurn("saved"));
    const before = await store.load(session.transcript().id);
    if (before === null) throw new Error("expected stored Transcript");

    await expect(Array.fromAsync(session.runTurn("failed"))).rejects.toBeInstanceOf(TurnError);
    expect(await store.load(before.id)).toEqual(before);
    return before.id;
  });
  const summariesBefore = await store.list();

  await withSession(definition, { transcripts: store, resume: transcriptId }, async (session) => {
    const iterator = session.runTurn("interrupted")[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
  });

  expect(await store.list()).toEqual(summariesBefore);
});
