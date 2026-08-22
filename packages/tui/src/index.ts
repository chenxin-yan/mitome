import type { Host } from "@mitome/core";

export const tui = (): Host => ({
  name: "tui",
  mode: "interactive",
  // ADR-0038's validated MVP terminal matrix; widen after validating another terminal.
  unsupported: () =>
    process.platform === "linux" && process.env.TERM_PROGRAM?.toLowerCase() === "ghostty"
      ? undefined
      : "@mitome/tui currently supports Ghostty on Linux",
  run: async ({ prompt }) => {
    await import("@opentui/solid/preload");
    const { runShell } = await import("./shell.jsx");
    await runShell(prompt);
  },
});
