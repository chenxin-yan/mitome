import { defineMitome as defineCoreMitome } from "@mitome/core";
import type { AgentDefinition, Host, MitomeDefinition as CoreMitomeDefinition } from "@mitome/core";
import type { TranscriptStore } from "./transcript-store.js";
import { toCoreTranscriptStore } from "./transcript-store.js";

export type MitomeDefinition<Agent extends AgentDefinition = AgentDefinition> = Omit<
  CoreMitomeDefinition<Agent>,
  "transcripts"
>;

export const defineMitome = <const Agent extends AgentDefinition>(definition: {
  readonly agent: Agent;
  readonly hosts?: ReadonlyArray<Host>;
  readonly transcripts?: TranscriptStore | undefined;
}): MitomeDefinition<Agent> =>
  defineCoreMitome({
    ...definition,
    transcripts:
      definition.transcripts === undefined
        ? undefined
        : toCoreTranscriptStore(definition.transcripts),
  });
