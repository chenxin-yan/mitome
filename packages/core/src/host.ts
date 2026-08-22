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

export interface MitomeDefinition<Agent extends AgentDefinition = AgentDefinition> {
  readonly agent: Agent;
  readonly hosts: ReadonlyArray<Host>;
}

export const defineMitome = <const Agent extends AgentDefinition>(
  definition: MitomeDefinition<Agent>,
): MitomeDefinition<Agent> => {
  if (definition.hosts.length > 1) {
    throw new Error("Mitome Definition must declare at most one interactive Host.");
  }
  return definition;
};
