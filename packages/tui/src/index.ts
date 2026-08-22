import type { Host } from "@mitome/core";

export const tui = (): Host => ({
  name: "tui",
  mode: "interactive",
  run: async ({ prompt }) => {
    await import("@opentui/solid/preload");
    const { runShell } = await import("./shell.jsx");
    await runShell(prompt);
  },
});
