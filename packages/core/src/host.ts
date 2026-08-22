import type { AgentDefinition } from "./agent.js";

export interface HostContext {
  readonly agent: AgentDefinition;
  readonly prompt: string;
}

export interface Host {
  readonly name: string;
  readonly mode: "interactive";
  /** Reason this Host cannot run in the current environment, or undefined when it can. */
  readonly unsupported?: () => string | undefined;
  readonly run: (context: HostContext) => Promise<void>;
}

export interface MitomeDefinition {
  readonly agent: AgentDefinition;
  readonly hosts: ReadonlyArray<Host>;
}

export const defineMitome = (definition: MitomeDefinition): MitomeDefinition => {
  if (definition.hosts.length > 1) {
    throw new Error("Mitome Definition must declare at most one interactive Host.");
  }
  return definition;
};
