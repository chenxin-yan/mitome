import { defineMitome as defineCoreMitome } from "@mitome/core";
import type { AgentDefinition, Host } from "@mitome/core";
import type { TranscriptStore } from "./transcript-store.js";
import { toCoreTranscriptStore } from "./transcript-store.js";

/**
 * The composition root pairing one Agent Definition with its Hosts; a Mitome Definition module
 * exports it as default for the CLI to load. Hosts are opaque here because they are authored
 * against `@mitome/core`.
 */
export interface MitomeDefinition<Agent extends AgentDefinition = AgentDefinition> {
  readonly agent: Agent;
  /** Zero or one Host value from a Host package such as `@mitome/tui`. */
  readonly hosts: ReadonlyArray<unknown>;
}

/**
 * Creates a Mitome Definition. Omit `hosts` for one-shot use; more than one Host throws. Omit
 * `transcripts` to write no Transcript data; when given, every Host shares that store.
 */
export const defineMitome = <const Agent extends AgentDefinition>(definition: {
  readonly agent: Agent;
  readonly hosts?: ReadonlyArray<unknown>;
  readonly transcripts?: TranscriptStore | undefined;
}): MitomeDefinition<Agent> =>
  defineCoreMitome({
    agent: definition.agent,
    // SAFETY: Hosts are authored against @mitome/core. The Promise facade keeps them opaque so
    // their Effect-native context does not leak into this entry point.
    hosts: (definition.hosts ?? []) as ReadonlyArray<Host>,
    transcripts:
      definition.transcripts === undefined
        ? undefined
        : toCoreTranscriptStore(definition.transcripts),
  });
