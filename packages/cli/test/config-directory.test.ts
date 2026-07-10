import { describe, expect, test } from "vitest";
import { resolveConfigDirectory } from "@mitome/core";

describe("resolveConfigDirectory", () => {
  test("uses XDG_CONFIG_HOME before every platform fallback", () => {
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

  test("uses APPDATA on Windows and HOME on Unix", () => {
    expect(resolveConfigDirectory({ APPDATA: "C:\\Users\\alice\\AppData\\Roaming" }, "win32")).toBe(
      "C:\\Users\\alice\\AppData\\Roaming\\mitome",
    );
    expect(resolveConfigDirectory({ HOME: "/home/alice" }, "linux")).toBe(
      "/home/alice/.config/mitome",
    );
  });

  test("reports the missing config roots", () => {
    expect(() => resolveConfigDirectory({}, "linux")).toThrow("XDG_CONFIG_HOME");
    expect(() => resolveConfigDirectory({}, "win32")).toThrow("APPDATA");
  });
});
