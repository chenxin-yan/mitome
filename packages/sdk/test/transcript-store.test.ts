import { expect, test } from "vitest";
import { Effect, Stream } from "effect";
import { Response } from "effect/unstable/ai";
import {
  defineAgent,
  makeMemoryTranscriptStore,
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

test("snapshots and resumes prior context through the public SDK", async () => {
  const store = makeMemoryTranscriptStore();
  const prompts: Array<ReadonlyArray<string>> = [];
  const definition = definitionWith(({ prompt }) => {
    prompts.push(prompt.content.map((message) => message.role));
    return textResponse("hello");
  });

  const parentId = await withSession(definition, { store }, async (session) => {
    await Array.fromAsync(session.prompt("first"));
    return session.transcript().id;
  });
  const child = await withSession(definition, { store, resume: parentId }, async (session) => {
    await Array.fromAsync(session.prompt("second"));
    return session.transcript();
  });

  expect(prompts).toEqual([["user"], ["user", "assistant", "user"]]);
  expect(child.id).not.toBe(parentId);
  expect(child.parentTranscriptId).toBe(parentId);
  expect(await Effect.runPromise(store.load(child.id))).toEqual(child);
});

test("two resumes create independent child Transcripts with parent provenance", async () => {
  const store = makeMemoryTranscriptStore();
  const definition = definitionWith(() => textResponse("done"));
  const parentId = await withSession(definition, { store }, async (session) => {
    await Array.fromAsync(session.prompt("parent"));
    return session.transcript().id;
  });

  const resume = (text: string) =>
    withSession(definition, { store, resume: parentId }, async (session) => {
      await Array.fromAsync(session.prompt(text));
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
    await Array.fromAsync(session.prompt("continue"));
    return session.transcript();
  });

  expect(roles).toEqual(["user", "user"]);
  expect(transcript.parentTranscriptId).toBe("synthetic");
});

test("failed and interrupted Turns leave stored Transcripts unchanged", async () => {
  const store = makeMemoryTranscriptStore();
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

  const transcriptId = await withSession(definition, { store }, async (session) => {
    await Array.fromAsync(session.prompt("saved"));
    const before = await Effect.runPromise(store.load(session.transcript().id));

    await expect(Array.fromAsync(session.prompt("failed"))).rejects.toBeInstanceOf(TurnError);
    expect(await Effect.runPromise(store.load(before.id))).toEqual(before);
    return before.id;
  });
  const summariesBefore = await Effect.runPromise(store.list());

  await withSession(definition, { store, resume: transcriptId }, async (session) => {
    const iterator = session.prompt("interrupted")[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
  });

  expect(await Effect.runPromise(store.list())).toEqual(summariesBefore);
});
