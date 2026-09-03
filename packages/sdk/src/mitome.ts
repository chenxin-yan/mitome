import { defineMitome as defineCoreMitome } from "@mitome/core";
import type { AgentDefinition, Host } from "@mitome/core";
import type { TranscriptStore } from "./transcript-store.js";
import { toCoreTranscriptStore } from "./transcript-store.js";

export interface MitomeDefinition<Agent extends AgentDefinition = AgentDefinition> {
  readonly agent: Agent;
  readonly hosts: ReadonlyArray<unknown>;
}

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
