import { describe, expect, it } from "bun:test";
import packageJson from "../package.json" with { type: "json" };

const expectedVersion = "0.5.3";

describe("OpenTUI spike dependency pair", () => {
  it("pins the renderer and Solid reconciler to the same exact version", () => {
    expect(packageJson.dependencies["@opentui/core"]).toBe(expectedVersion);
    expect(packageJson.dependencies["@opentui/solid"]).toBe(expectedVersion);
  });
});
