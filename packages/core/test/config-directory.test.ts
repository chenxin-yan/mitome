import { describe, expect, it } from "@effect/vitest";
import { configDirectory } from "../src/config.js";

describe("configDirectory", () => {
  it("uses MITOME_HOME verbatim, before every other variable", () => {
    expect(
      configDirectory({ MITOME_HOME: "/repo/.dev-home", XDG_CONFIG_HOME: "/xdg" }, "linux"),
    ).toBe("/repo/.dev-home");
    expect(
      configDirectory({ MITOME_HOME: "C:\\repo\\.dev-home", APPDATA: "/appdata" }, "win32"),
    ).toBe("C:\\repo\\.dev-home");
  });

  it("uses XDG_CONFIG_HOME before every platform fallback", () => {
    expect(configDirectory({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/alice" }, "linux")).toBe(
      "/xdg/mitome",
    );
    expect(configDirectory({ XDG_CONFIG_HOME: "/xdg", APPDATA: "/appdata" }, "win32")).toBe(
      "/xdg/mitome",
    );
  });

  it("uses APPDATA on Windows and HOME on Unix", () => {
    expect(configDirectory({ APPDATA: "/appdata", HOME: "/home/alice" }, "win32")).toBe(
      "/appdata/mitome",
    );
    expect(configDirectory({ HOME: "/home/alice" }, "linux")).toBe("/home/alice/.config/mitome");
  });

  it("treats empty-string variables as unset", () => {
    expect(configDirectory({ MITOME_HOME: "", HOME: "/home/alice" }, "linux")).toBe(
      "/home/alice/.config/mitome",
    );
    expect(configDirectory({ XDG_CONFIG_HOME: "", HOME: "/home/alice" }, "linux")).toBe(
      "/home/alice/.config/mitome",
    );
    expect(configDirectory({ XDG_CONFIG_HOME: "", HOME: "" }, "linux")).toBeUndefined();
  });

  it("returns undefined when no config root is set", () => {
    expect(configDirectory({}, "linux")).toBeUndefined();
    expect(configDirectory({}, "win32")).toBeUndefined();
  });
});
