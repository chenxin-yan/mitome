import { describe, expect, it } from "@effect/vitest";
import * as Root from "../src/index.js";
import * as Kernel from "../src/kernel.js";

describe("@mitome/core/kernel", () => {
  it("holds the raw layer, which the root entry does not export", () => {
    for (const name of ["step", "loop", "localTools"]) {
      expect(Object.keys(Root)).not.toContain(name);
      expect(Object.keys(Kernel)).toContain(name);
    }
    expect(Object.keys(Kernel).sort()).toEqual(["Session", "localTools", "loop", "step"]);
    // The root has a `Session` of its own from the Agent layer; it is never the kernel's.
    const root = new Map<string, unknown>(Object.entries(Root));
    for (const [name, value] of Object.entries(Kernel)) {
      expect(root.get(name)).not.toBe(value);
    }
  });
});
