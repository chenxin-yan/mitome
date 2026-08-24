import type { Host } from "@mitome/core";

export const tui = (): Host => ({
  name: "tui",
  mode: "interactive",
  unsupported: () =>
    process.stdin.isTTY === true && process.stdout.isTTY === true
      ? undefined
      : "@mitome/tui requires an interactive terminal",
  run: async ({ prompt }) => {
    await import("@opentui/solid/preload");
    const { runShell } = await import("./shell.jsx");
    await runShell(prompt);
  },
});
