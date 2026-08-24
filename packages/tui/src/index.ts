import { join } from "node:path";
import type { Host } from "@mitome/core";

export const tui = (): Host => ({
  name: "tui",
  mode: "interactive",
  unsupported: () =>
    process.stdin.isTTY === true && process.stdout.isTTY === true
      ? undefined
      : "@mitome/tui requires an interactive terminal",
  run: async ({ agent, prompt }) => {
    await import("@opentui/solid/preload");
    const [
      { configDirectory, configDirectoryMessage, createSession, makeFileTranscriptStore },
      { Effect },
      { runShell },
      { makeConversationViewModel },
    ] = await Promise.all([
      import("@mitome/core"),
      import("effect"),
      import("./shell.jsx"),
      import("./view-model.js"),
    ]);
    const home = configDirectory();
    if (home === undefined) throw new Error(configDirectoryMessage);
    const store = makeFileTranscriptStore(join(home, "transcripts"));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(agent, { store });
          const viewModel = makeConversationViewModel(session);
          yield* Effect.promise(() => runShell(viewModel, prompt));
        }),
      ),
    );
  },
});
