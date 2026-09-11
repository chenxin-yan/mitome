import { Predicate } from "effect";
import type { AgentDefinition } from "./agent.js";
import { createSession } from "./session/session.js";
import type { TranscriptStore } from "./transcript-store.js";

/** What a Host receives to run Sessions for one Mitome Definition. */
export interface HostContext {
  readonly agent: AgentDefinition;
  /** First user Message to submit, or `""` when the user gave none. */
  readonly message: string;
  /** Store the Mitome Definition composed; absent means nothing is persisted. */
  readonly transcripts?: TranscriptStore | undefined;
}

/**
 * Drives Sessions on a user's behalf, such as the CLI's one-shot Host or `@mitome/tui`. A Mitome
 * Definition composes at most one Host, and the CLI falls back to one-shot output when
 * `unsupported()` returns a reason.
 */
export interface Host {
  /** Reason this Host cannot run in the current environment, or undefined when it can. */
  readonly unsupported?: () => string | undefined;
  /** Runs Sessions for the context and resolves when the Host is finished. */
  readonly run: (context: HostContext) => Promise<void>;
}

/**
 * The composition root pairing one Agent Definition with its Hosts and Transcript persistence. A
 * Mitome Definition module exports it as default; `defineMitome` creates it.
 */
export interface MitomeDefinition<Agent extends AgentDefinition = AgentDefinition> {
  readonly agent: Agent;
  /** Zero or one Host. */
  readonly hosts: ReadonlyArray<Host>;
  /** Store shared by every Host; absent means no Transcript data is written. */
  readonly transcripts?: TranscriptStore | undefined;
}

/** Opens the scoped Session a Host runs for its context; closing the Scope ends the Session. */
export const createHostSession = (context: HostContext) =>
  createSession(context.agent, { transcripts: context.transcripts });

/**
 * Creates a Mitome Definition. `hosts` defaults to none; more than one Host, or a value that is not
 * a Host (typically a factory that was not called), throws.
 */
export const defineMitome = <const Agent extends AgentDefinition>(
  definition: Omit<MitomeDefinition<Agent>, "hosts"> & {
    readonly hosts?: ReadonlyArray<Host>;
  },
): MitomeDefinition<Agent> => {
  const hosts = definition.hosts === undefined ? [] : definition.hosts;
  if (
    hosts.some(
      (host) =>
        !Predicate.isObject(host) ||
        !Predicate.isFunction(host.run) ||
        (host.unsupported !== undefined && !Predicate.isFunction(host.unsupported)),
    )
  ) {
    throw new Error(
      "Host must be an object with a run function and optional unsupported function — did you forget to call the factory?",
    );
  }
  if (hosts.length > 1) {
    throw new Error("Mitome Definition must declare at most one Host.");
  }
  return { ...definition, hosts };
};
