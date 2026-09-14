import { describe, expect, it } from "vitest";
import {
  defineMitome,
  memoryTranscripts,
  type AgentDefinition,
  type ChannelHost,
  type Host,
  type InteractiveHost,
} from "../src/index.js";

// SAFETY: defineMitome only stores the Agent Definition; this unit test never compiles it.
const agent = {} as AgentDefinition;
const interactive: InteractiveHost = {
  kind: "interactive",
  run: async () => undefined,
};
const channel: ChannelHost = {
  kind: "channel",
  name: "telegram",
  serve: async () => undefined,
};

describe("defineMitome", () => {
  it("defaults Hosts to an empty array", () => {
    expect(defineMitome({ agent })).toEqual({ agent, hosts: [] });
  });

  it("returns an explicit agent, Host, and Transcript store composition", () => {
    const transcripts = memoryTranscripts();
    expect(defineMitome({ agent, hosts: [interactive], transcripts })).toEqual({
      agent,
      hosts: [interactive],
      transcripts,
    });
  });

  it("accepts several interactive Hosts and Channel Hosts with distinct names", () => {
    const hosts = [interactive, { ...interactive }, channel, { ...channel, name: "slack" }];
    expect(defineMitome({ agent, hosts }).hosts).toBe(hosts);
  });

  it.each<readonly [string, ReadonlyArray<unknown>, string]>([
    [
      "an uncalled factory",
      [interactive, () => interactive],
      "Host at index 1 must be an object with a kind — did you forget to call the factory?",
    ],
    [
      "a Host without a kind",
      [{ run: async () => undefined }],
      "Host at index 0 must be an object with a kind — did you forget to call the factory?",
    ],
    [
      "an unknown kind",
      [{ kind: "gateway", run: async () => undefined }],
      'Host at index 0 has unknown kind "gateway"; expected "interactive" or "channel".',
    ],
    [
      "a kind JSON cannot serialize",
      [{ kind: 1n }],
      'Host at index 0 has a non-string kind; expected "interactive" or "channel".',
    ],
    [
      "an interactive Host without run",
      [{ kind: "interactive" }],
      "Interactive Host at index 0 must have a run function and optional unsupported function.",
    ],
    [
      "a Channel Host without a name",
      [{ kind: "channel", serve: async () => undefined }],
      "Channel Host at index 0 must have a non-empty string name.",
    ],
    [
      "a Channel Host named after a URL dot segment",
      [{ kind: "channel", name: "..", handle: async () => new Response() }],
      'Channel Host at index 0 must not be named "." or "..".',
    ],
    [
      "a Channel Host name with a lone surrogate",
      [
        {
          kind: "channel",
          name: `bad${String.fromCharCode(0xd800)}`,
          serve: async () => undefined,
        },
      ],
      "Channel Host at index 0 must have a well-formed name without lone surrogates.",
    ],
    [
      "a Channel Host with neither handle nor serve",
      [{ kind: "channel", name: "telegram" }],
      'Channel Host "telegram" must expose a handle or serve function.',
    ],
    [
      "a Channel Host whose handle is not a function",
      [{ kind: "channel", name: "telegram", handle: true }],
      'Channel Host "telegram" must expose a handle or serve function.',
    ],
    [
      "duplicate Channel Host names",
      [channel, interactive, { ...channel, handle: async () => new Response() }],
      'Channel Host name "telegram" is declared more than once.',
    ],
  ])("rejects %s naming the offending Host", (_, hosts, message) => {
    // SAFETY: These fixtures deliberately violate the Host contract to exercise runtime validation.
    expect(() => defineMitome({ agent, hosts: hosts as ReadonlyArray<Host> })).toThrow(message);
  });
});
