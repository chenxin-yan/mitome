import type { Host } from "@mitome/core";
import { Effect } from "effect";

export const tui = (): Host => ({
  unsupported: () =>
    process.stdin.isTTY === true && process.stdout.isTTY === true
      ? undefined
      : "@mitome/tui requires an interactive terminal",
  run: async (context) => {
    // opentui must stay deferred: it touches the terminal at import time and
    // must not load in non-TTY contexts (see host.test.ts). The local modules
    // stay dynamic to satisfy oxlint's no-service-constructor-imports.
    await import("@opentui/solid/preload");
    const [{ runShell }, { makeSessionManager }, { makeSessionViewModel }] = await Promise.all([
      import("./shell.jsx"),
      import("./session-manager.js"),
      import("./view-model.js"),
    ]);
    const manager = makeSessionManager(context);
    const session = await Effect.runPromise(manager.open());
    const viewModel = makeSessionViewModel(session, manager);
    await runShell(viewModel, context.message);
  },
});
