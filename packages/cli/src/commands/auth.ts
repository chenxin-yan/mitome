import { Effect, Option, Redacted } from "effect";
import { Prompt } from "effect/unstable/cli";
import { inspectCredential, runOAuthAuth } from "../child-host.js";
import { removeConfigEnv, updateConfigEnv } from "../config.js";
import { checkRuntime, definitionPath } from "../definition.js";
import { attempt, fail, runNativePrompt, waitForChild } from "../support.js";

export const runAuth = (command: "login" | "logout", use: Option.Option<string>) =>
  Effect.gen(function* () {
    const path = yield* attempt(() => definitionPath(use));
    yield* attempt(() => checkRuntime(path));
    const credential = yield* waitForChild(() => inspectCredential(path));
    if (typeof credential !== "string") {
      yield* waitForChild(() => runOAuthAuth(path, command));
      return;
    }
    if (command === "logout") {
      yield* attempt(() => removeConfigEnv(credential));
      return;
    }
    const value = Redacted.value(yield* runNativePrompt(Prompt.password({ message: credential })));
    if (value === "") return yield* fail("Credential value is required.");
    yield* attempt(() => updateConfigEnv(credential, value));
  });
