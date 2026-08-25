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
    const [{ createHostSession }, { Effect }, { runShell }, { makeSessionViewModel }] =
      await Promise.all([
        import("@mitome/core"),
        import("effect"),
        import("./shell.jsx"),
        import("./view-model.js"),
      ]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createHostSession(context);
          const viewModel = makeSessionViewModel(session);
          yield* Effect.promise(() => runShell(viewModel, context.prompt));
        }),
      ),
    );
  },
});
