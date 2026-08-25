import type { Host } from "@mitome/core";

export const tui = (): Host => ({
  name: "tui",
  mode: "interactive",
  unsupported: () =>
    process.stdin.isTTY === true && process.stdout.isTTY === true
      ? undefined
      : "@mitome/tui requires an interactive terminal",
  run: async (context) => {
    await import("@opentui/solid/preload");
    const [{ Effect }, { runShell }, { makeSessionManager }, { makeSessionViewModel }] =
      await Promise.all([
        import("effect"),
        import("./shell.jsx"),
        import("./session-manager.js"),
        import("./view-model.js"),
      ]);
    const manager = makeSessionManager(context);
    const session = await Effect.runPromise(manager.open());
    const viewModel = makeSessionViewModel(session, manager);
    await runShell(viewModel, context.prompt);
  },
});
