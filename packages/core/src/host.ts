import { Predicate } from "effect";
import type { AgentDefinition } from "./agent.js";
import { createSession } from "./session/session.js";
import type { TranscriptStore } from "./transcript-store.js";

/** What a Channel Host receives to run Sessions for one Mitome Definition. */
export interface ChannelHostContext {
  readonly agent: AgentDefinition;
  /** Store the Mitome Definition composed; absent means nothing is persisted. */
  readonly transcripts?: TranscriptStore | undefined;
}

/** What an interactive Host receives: the Channel Host context plus the staged first Message. */
export interface HostContext extends ChannelHostContext {
  /** First user Message to submit, or `""` when the user gave none. */
  readonly message: string;
}

/**
 * A Host that owns a TTY process, such as `@mitome/tui`. `mitome [message]` runs the first
 * interactive Host in Definition order whose `unsupported()` returns undefined and otherwise falls
 * back to one-shot output.
 */
export interface InteractiveHost {
  readonly kind: "interactive";
  /** Reason this Host cannot run in the current environment, or undefined when it can. */
  readonly unsupported?: () => string | undefined;
  /** Runs Sessions for the context and resolves when the Host is finished. */
  readonly run: (context: HostContext) => Promise<void>;
}

/**
 * A Host that connects an external surface to the Agent. It must expose `handle`, `serve`, or
 * both; `defineMitome` rejects a Channel Host with neither. `mitome [message]` ignores Channel
 * Hosts; `mitome serve` runs them.
 */
export interface ChannelHost {
  readonly kind: "channel";
  /** Identifies the Channel; unique among the Channel Hosts of one Mitome Definition. */
  readonly name: string;
  /**
   * Answers one request; the response body owns the Session scope until it ends or is cancelled.
   * `mitome serve` mounts it under `/<name>` and strips that prefix, so the request URL path is the
   * remainder (`/` when nothing follows) and the Channel never sees its own name.
   */
  readonly handle?: (context: ChannelHostContext, request: Request) => Promise<Response>;
  /** Runs a long-lived connection and resolves only after the signal aborts and shutdown completes. */
  readonly serve?: (context: ChannelHostContext, signal: AbortSignal) => Promise<void>;
}

/** Connects people to the Agent through one surface; discriminated by `kind`. */
export type Host = InteractiveHost | ChannelHost;

/**
 * The composition root pairing one Agent Definition with its Hosts and Transcript persistence. A
 * Mitome Definition module exports it as default; `defineMitome` creates it.
 */
export interface MitomeDefinition<Agent extends AgentDefinition = AgentDefinition> {
  readonly agent: Agent;
  /** Hosts in declaration order; interactive Hosts are tried in this order. */
  readonly hosts: ReadonlyArray<Host>;
  /** Store shared by every Host; absent means no Transcript data is written. */
  readonly transcripts?: TranscriptStore | undefined;
}

/** Opens the scoped Session a Host runs for its context; closing the Scope ends the Session. */
export const createHostSession = (context: ChannelHostContext) =>
  createSession(context.agent, { transcripts: context.transcripts });

/** A declared Host as it may actually arrive at runtime, before validation. */
interface HostCandidate {
  readonly kind?: unknown;
  readonly name?: unknown;
  readonly run?: unknown;
  readonly unsupported?: unknown;
  readonly handle?: unknown;
  readonly serve?: unknown;
}

const hasOptionalFunction = (
  host: HostCandidate,
  member: "unsupported" | "handle" | "serve",
): boolean => host[member] === undefined || Predicate.isFunction(host[member]);

// packages/cli/src/hosts/host.ts mirrors these checks and messages; it cannot import them.
const hostIssue = (host: Host, index: number): string | undefined => {
  if (!Predicate.isObject(host)) {
    return `Host at index ${index} must be an object with a kind — did you forget to call the factory?`;
  }
  const candidate: HostCandidate = host;
  if (candidate.kind === undefined) {
    return `Host at index ${index} must be an object with a kind — did you forget to call the factory?`;
  }
  if (candidate.kind === "interactive") {
    return Predicate.isFunction(candidate.run) && hasOptionalFunction(candidate, "unsupported")
      ? undefined
      : `Interactive Host at index ${index} must have a run function and optional unsupported function.`;
  }
  if (candidate.kind === "channel") {
    if (!Predicate.isString(candidate.name) || candidate.name === "") {
      return `Channel Host at index ${index} must have a non-empty string name.`;
    }
    return hasOptionalFunction(candidate, "handle") &&
      hasOptionalFunction(candidate, "serve") &&
      (candidate.handle !== undefined || candidate.serve !== undefined)
      ? undefined
      : `Channel Host "${candidate.name}" must expose a handle or serve function.`;
  }
  // Only strings are echoed; JSON.stringify would throw on bigint or cyclic kinds.
  return Predicate.isString(candidate.kind)
    ? `Host at index ${index} has unknown kind "${candidate.kind}"; expected "interactive" or "channel".`
    : `Host at index ${index} has a non-string kind; expected "interactive" or "channel".`;
};

/**
 * Creates a Mitome Definition. `hosts` defaults to none and may hold any number of Hosts. A value
 * that is not a Host (typically a factory that was not called), an unknown `kind`, a Channel Host
 * without `handle` or `serve`, or two Channel Hosts sharing a name throws with the offending Host
 * named.
 */
export const defineMitome = <const Agent extends AgentDefinition>(
  definition: Omit<MitomeDefinition<Agent>, "hosts"> & {
    readonly hosts?: ReadonlyArray<Host>;
  },
): MitomeDefinition<Agent> => {
  const hosts = definition.hosts === undefined ? [] : definition.hosts;
  const channelNames = new Set<string>();
  hosts.forEach((host, index) => {
    const issue = hostIssue(host, index);
    if (issue !== undefined) throw new Error(issue);
    if (host.kind !== "channel") return;
    if (channelNames.has(host.name)) {
      throw new Error(`Channel Host name "${host.name}" is declared more than once.`);
    }
    channelNames.add(host.name);
  });
  return { ...definition, hosts };
};
