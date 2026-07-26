import { Effect, Option, Redacted } from "effect";
import { Prompt } from "effect/unstable/cli";
import {
  inspectProviderAuthentication,
  runOAuthAuth,
  type ProviderAuthentication,
} from "../child-host.js";
import { removeConfigEnv, updateConfigEnv } from "../config.js";
import { checkRuntime, definitionPath } from "../definition.js";
import { attempt, fail, stdinCanPrompt, waitForChild } from "../support.js";

const selectProvider = (providers: ReadonlyArray<ProviderAuthentication>) =>
  Effect.gen(function* () {
    if (providers.length === 0)
      return yield* fail("Agent Definition has no auth-capable Providers.");
    if (providers.length === 1) return providers[0]!;
    if (!stdinCanPrompt()) {
      return yield* fail(
        `Multiple auth-capable Providers; choose one interactively: ${providers.map(({ id }) => id).join(", ")}`,
      );
    }
    return yield* Prompt.run(
      Prompt.select<ProviderAuthentication>({
        message: "Provider",
        choices: providers.map((provider) => ({ title: provider.id, value: provider })),
      }),
    );
  });

export const authenticateDefinition = (path: string, command: "login" | "logout") =>
  Effect.gen(function* () {
    const providers = yield* waitForChild(() => inspectProviderAuthentication(path));
    const selected = yield* selectProvider(providers);
    const credential = selected.credential;
    if (typeof credential !== "string") {
      yield* waitForChild(() => runOAuthAuth(path, selected.id, command));
      return;
    }
    if (command === "logout") {
      yield* attempt(() => removeConfigEnv(credential));
      return;
    }
    const value = Redacted.value(yield* Prompt.run(Prompt.password({ message: credential })));
    if (value === "") return yield* fail("Credential value is required.");
    yield* attempt(() => updateConfigEnv(credential, value));
  });

export const runAuth = (command: "login" | "logout", use: Option.Option<string>) =>
  Effect.gen(function* () {
    const path = yield* attempt(() => definitionPath(use));
    yield* attempt(() => checkRuntime(path));
    yield* authenticateDefinition(path, command);
  });
