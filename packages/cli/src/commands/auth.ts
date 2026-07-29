import { Effect, Option } from "effect";
import { ChildHost, type ProviderAuthentication } from "../child-host.js";
import { removeConfigEnv, updateConfigEnv } from "../config.js";
import { checkRuntime, definitionPath } from "../definition.js";
import { Prompter } from "../prompter.js";
import { attempt, fail, type ExitCode } from "../support.js";

const selectProvider = (providers: ReadonlyArray<ProviderAuthentication>) =>
  Effect.gen(function* () {
    if (providers.length === 0)
      return yield* fail("Agent Definition has no auth-capable Providers.");
    if (providers.length === 1) return providers[0]!;
    const prompter = yield* Prompter;
    if (!(yield* prompter.canPrompt)) {
      return yield* fail(
        `Multiple auth-capable Providers; choose one interactively: ${providers.map(({ id }) => id).join(", ")}`,
      );
    }
    return yield* prompter.select({
      message: "Provider",
      choices: providers.map((provider) => ({ title: provider.id, value: provider })),
    });
  });

export const authenticateDefinition = Effect.fn("@mitome/cli/authenticateDefinition")(function* (
  path: string,
  command: "login" | "logout",
) {
  const childHost = yield* ChildHost;
  const providers = yield* childHost.inspectProviderAuthentication(path);
  const selected = yield* selectProvider(providers);
  const credential = selected.credential;
  if (typeof credential !== "string") {
    yield* childHost.runOAuthAuth(path, selected.id, command);
    return;
  }
  if (command === "logout") {
    yield* attempt(() => removeConfigEnv(credential));
    return;
  }
  const prompter = yield* Prompter;
  const value = yield* prompter.password(credential);
  if (value === "") return yield* fail("Credential value is required.");
  yield* attempt(() => updateConfigEnv(credential, value));
});

export const runAuth = Effect.fn("@mitome/cli/runAuth")(function* (
  command: "login" | "logout",
  use: Option.Option<string>,
) {
  const path = yield* attempt(() => definitionPath(use));
  yield* attempt(() => checkRuntime(path));
  yield* authenticateDefinition(path, command);
  return 0 satisfies ExitCode;
});
