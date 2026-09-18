import { readFile } from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import { knownModelIds, knownModelMetadata } from "../../src/openai/models.js";

interface SnapshotModel {
  readonly id: string;
  readonly contextWindow?: number;
}

describe("generated OpenAI model hints", () => {
  it("mirrors the committed models.dev snapshot exactly", async () => {
    // SAFETY: the generator decoded this repository-owned snapshot with a stricter schema when it emitted models.ts.
    const snapshot = JSON.parse(
      await readFile(
        new URL("../../../../scripts/models-dev.snapshot.json", import.meta.url),
        "utf8",
      ),
    ) as { openai: ReadonlyArray<SnapshotModel> };

    expect(knownModelIds).toEqual(snapshot.openai.map((model) => model.id));
    expect(knownModelMetadata).toEqual(
      Object.fromEntries(
        snapshot.openai.flatMap((model) =>
          model.contextWindow === undefined
            ? []
            : [[model.id, { contextWindow: model.contextWindow }]],
        ),
      ),
    );
  });
});
