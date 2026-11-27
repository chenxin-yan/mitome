import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { configDirectory, stateDirectory } from "../src/directories.js";

describe("configDirectory", () => {
  it("uses MITOME_HOME verbatim, before every other variable", () => {
    expect(
      configDirectory({ MITOME_HOME: "/repo/.dev-home", XDG_CONFIG_HOME: "/xdg" }, "linux"),
    ).toBe("/repo/.dev-home");
    expect(
      configDirectory({ MITOME_HOME: String.raw`C:\repo\.dev-home`, APPDATA: "/appdata" }, "win32"),
    ).toBe(String.raw`C:\repo\.dev-home`);
  });

  it("uses XDG_CONFIG_HOME before every platform fallback", () => {
    expect(configDirectory({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/alice" }, "linux")).toBe(
      join("/xdg", "mitome"),
    );
    expect(configDirectory({ XDG_CONFIG_HOME: "/xdg", APPDATA: "/appdata" }, "win32")).toBe(
      join("/xdg", "mitome"),
    );
  });

  it("uses APPDATA on Windows and HOME on Unix", () => {
    expect(configDirectory({ APPDATA: "/appdata", HOME: "/home/alice" }, "win32")).toBe(
      join("/appdata", "mitome"),
    );
    expect(configDirectory({ HOME: "/home/alice" }, "linux")).toBe(
      join("/home/alice", ".config", "mitome"),
    );
  });

  it("treats empty-string variables as unset", () => {
    expect(configDirectory({ MITOME_HOME: "", HOME: "/home/alice" }, "linux")).toBe(
      join("/home/alice", ".config", "mitome"),
    );
    expect(configDirectory({ XDG_CONFIG_HOME: "", HOME: "/home/alice" }, "linux")).toBe(
      join("/home/alice", ".config", "mitome"),
    );
    expect(configDirectory({ XDG_CONFIG_HOME: "", HOME: "" }, "linux")).toBeUndefined();
  });

  it("returns undefined when no config root is set", () => {
    expect(configDirectory({}, "linux")).toBeUndefined();
    expect(configDirectory({}, "win32")).toBeUndefined();
  });
});

describe("stateDirectory", () => {
  it("uses MITOME_HOME verbatim, before every other variable", () => {
    expect(
      stateDirectory({ MITOME_HOME: "/repo/.dev-home", XDG_STATE_HOME: "/xdg" }, "linux"),
    ).toBe("/repo/.dev-home");
    expect(
      stateDirectory(
        { MITOME_HOME: String.raw`C:\repo\.dev-home`, LOCALAPPDATA: "/local" },
        "win32",
      ),
    ).toBe(String.raw`C:\repo\.dev-home`);
  });

  it("uses XDG_STATE_HOME before every platform fallback", () => {
    expect(stateDirectory({ XDG_STATE_HOME: "/xdg", HOME: "/home/alice" }, "linux")).toBe(
      join("/xdg", "mitome"),
    );
    expect(stateDirectory({ XDG_STATE_HOME: "/xdg", LOCALAPPDATA: "/local" }, "win32")).toBe(
      join("/xdg", "mitome"),
    );
  });

  it("uses LOCALAPPDATA on Windows and HOME on Unix, never the config variables", () => {
    expect(
      stateDirectory({ LOCALAPPDATA: "/local", APPDATA: "/appdata", HOME: "/home/alice" }, "win32"),
    ).toBe(join("/local", "mitome"));
    expect(stateDirectory({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/alice" }, "linux")).toBe(
      join("/home/alice", ".local", "state", "mitome"),
    );
  });

  it("treats empty-string variables as unset", () => {
    expect(stateDirectory({ MITOME_HOME: "", HOME: "/home/alice" }, "linux")).toBe(
      join("/home/alice", ".local", "state", "mitome"),
    );
    expect(stateDirectory({ XDG_STATE_HOME: "", HOME: "/home/alice" }, "linux")).toBe(
      join("/home/alice", ".local", "state", "mitome"),
    );
    expect(stateDirectory({ XDG_STATE_HOME: "", HOME: "" }, "linux")).toBeUndefined();
  });

  it("returns undefined when no state root is set", () => {
    expect(stateDirectory({}, "linux")).toBeUndefined();
    expect(stateDirectory({ APPDATA: "/appdata" }, "win32")).toBeUndefined();
  });
});
