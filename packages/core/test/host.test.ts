import { describe, expect, it } from "vitest";
import { defineMitome, type AgentDefinition, type Host } from "../src/index.js";

const agent = {} as AgentDefinition;
const host: Host = {
  name: "test",
  mode: "interactive",
  run: async () => undefined,
};

describe("defineMitome", () => {
  it("returns an explicit agent and Host composition", () => {
    expect(defineMitome({ agent, hosts: [host] })).toEqual({ agent, hosts: [host] });
  });

  it("rejects multiple interactive Hosts", () => {
    expect(() => defineMitome({ agent, hosts: [host, { ...host, name: "other" }] })).toThrow(
      "Mitome Definition must declare at most one interactive Host",
    );
  });
});
