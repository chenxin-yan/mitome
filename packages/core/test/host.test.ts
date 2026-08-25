import { describe, expect, it } from "vitest";
import { defineMitome, memoryTranscripts, type AgentDefinition, type Host } from "../src/index.js";

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

  it("rejects multiple interactive Hosts", () => {
    expect(() => defineMitome({ agent, hosts: [host, { ...host, name: "other" }] })).toThrow(
      "Mitome Definition must declare at most one interactive Host",
    );
  });
});
