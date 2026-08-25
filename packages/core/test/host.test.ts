import { Effect, Stream } from "effect";
import { Response } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";
import {
  createHostSession,
  defineMitome,
  memoryTranscripts,
  type AgentDefinition,
  type Host,
} from "../src/index.js";
import { makeTestProvider } from "./support/provider.js";

// SAFETY: defineMitome only stores the Agent Definition; this unit test never compiles it.
const agent = {} as AgentDefinition;
const host: Host = {
  name: "test",
  mode: "interactive",
  run: async () => undefined,
};

describe("defineMitome", () => {
  it("returns an explicit agent, Host, and Transcript store composition", () => {
    const transcripts = memoryTranscripts();
    expect(defineMitome({ agent, hosts: [host], transcripts })).toEqual({
      agent,
      hosts: [host],
      transcripts,
    });
  });

  it("creates Host Sessions with the composition's Transcript store", async () => {
    const transcripts = memoryTranscripts();
    const provider = makeTestProvider(() =>
      Stream.succeed(Response.makePart("text-delta", { id: "response", delta: "hello" })),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createHostSession({
            agent: { providers: [provider], model: "test/default", extensions: [] },
            prompt: "",
            transcripts,
          });
          yield* Stream.runDrain(session.prompt("Hi"));
        }),
      ),
    );

    expect(await Effect.runPromise(transcripts.list())).toEqual([
      expect.objectContaining({ messageCount: 1, preview: "Hi" }),
    ]);
  });

  it("rejects multiple interactive Hosts", () => {
    expect(() => defineMitome({ agent, hosts: [host, { ...host, name: "other" }] })).toThrow(
      "Mitome Definition must declare at most one interactive Host",
    );
  });
});
