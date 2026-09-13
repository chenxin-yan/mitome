import { defineMitome as defineCoreMitome } from "@mitome/core";
import type { AgentDefinition, Host } from "@mitome/core";
import type { TranscriptStore } from "./transcript-store.js";
import { toCoreTranscriptStore } from "./transcript-store.js";

/**
 * The composition root pairing one Agent Definition with its Hosts; a Mitome Definition module
 * exports it as default for the CLI to load. Hosts are shallow `kind` handles here because they are
 * authored against `@mitome/core`.
 */
export interface MitomeDefinition<Agent extends AgentDefinition = AgentDefinition> {
  readonly agent: Agent;
  /** Host values from Host packages such as `@mitome/tui`, in declaration order. */
  readonly hosts: ReadonlyArray<{ readonly kind: "interactive" | "channel" }>;
}

/**
 * Creates a Mitome Definition. Omit `hosts` for one-shot use; a value that is not a Host, such as
 * an uncalled factory, throws. Omit `transcripts` to write no Transcript data; when given, every
 * Host shares that store.
 */
export const defineMitome = <const Agent extends AgentDefinition>(definition: {
  readonly agent: Agent;
  readonly hosts?: ReadonlyArray<{ readonly kind: "interactive" | "channel" }>;
  readonly transcripts?: TranscriptStore | undefined;
}): MitomeDefinition<Agent> =>
  defineCoreMitome({
    agent: definition.agent,
    // SAFETY: Hosts are authored against @mitome/core. The Promise facade sees only their `kind` so
    // their Effect-native context does not leak into this entry point; core validates the rest.
    hosts: (definition.hosts ?? []) as ReadonlyArray<Host>,
    transcripts:
      definition.transcripts === undefined
        ? undefined
        : toCoreTranscriptStore(definition.transcripts),
  });
