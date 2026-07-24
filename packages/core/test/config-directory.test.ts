import { describe, expect, it } from "@effect/vitest";
import { resolveConfigDirectory } from "../src/index.js";

describe("resolveConfigDirectory", () => {
  it("uses MITOME_HOME verbatim, before every other variable", () => {
    expect(
      resolveConfigDirectory({ MITOME_HOME: "/repo/.dev-home", XDG_CONFIG_HOME: "/xdg" }, "linux"),
    ).toBe("/repo/.dev-home");
    expect(
      resolveConfigDirectory(
        { MITOME_HOME: "C:\\repo\\.dev-home", APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
        "win32",
      ),
    ).toBe("C:\\repo\\.dev-home");
  });

  it("uses XDG_CONFIG_HOME before every platform fallback", () => {
    expect(resolveConfigDirectory({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/alice" }, "linux")).toBe(
      "/xdg/mitome",
    );
    expect(
      resolveConfigDirectory(
        { XDG_CONFIG_HOME: "C:\\xdg", APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
        "win32",
      ),
    ).toBe("C:\\xdg\\mitome");
  });

  it("uses APPDATA on Windows and HOME on Unix", () => {
    expect(resolveConfigDirectory({ APPDATA: "C:\\Users\\alice\\AppData\\Roaming" }, "win32")).toBe(
      "C:\\Users\\alice\\AppData\\Roaming\\mitome",
    );
    expect(resolveConfigDirectory({ HOME: "/home/alice" }, "linux")).toBe(
      "/home/alice/.config/mitome",
    );
  });

  it("treats empty-string variables as unset", () => {
    expect(resolveConfigDirectory({ MITOME_HOME: "", HOME: "/home/alice" }, "linux")).toBe(
      "/home/alice/.config/mitome",
    );
    expect(resolveConfigDirectory({ XDG_CONFIG_HOME: "", HOME: "/home/alice" }, "linux")).toBe(
      "/home/alice/.config/mitome",
    );
    expect(resolveConfigDirectory({ XDG_CONFIG_HOME: "", HOME: "" }, "linux")).toBeUndefined();
  });

  it("returns undefined when no config root is set", () => {
    expect(resolveConfigDirectory({}, "linux")).toBeUndefined();
    expect(resolveConfigDirectory({}, "win32")).toBeUndefined();
  });
});
