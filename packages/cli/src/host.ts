// Runs inside the embedded Bun runtime with the Definition path as argv[1].
// index.ts embeds this file as text and never bundles it: Core and Effect are
// resolved beside the selected Definition at runtime so the host shares the
// exact module instances the Definition was installed against. The static
// imports below are type-only or node builtins, so nothing else is pulled in.
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { Definition, TurnEvent } from "@mitome/core";

const definitionPath = process.argv[1]!;
const corePath = Bun.resolveSync("@mitome/core", dirname(definitionPath));
const effectPath = Bun.resolveSync("effect", dirname(corePath));
const core: typeof import("@mitome/core") = await import(pathToFileURL(corePath).href);
const effect: typeof import("effect") = await import(pathToFileURL(effectPath).href);
const loaded: unknown = (
  (await import(pathToFileURL(definitionPath).href)) as { readonly default: unknown }
).default;

const isDefinition = (value: unknown): value is Definition => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Definition>;
  return (
    typeof candidate.instructions === "string" &&
    candidate.model !== undefined &&
    Array.isArray(candidate.plugins) &&
    candidate.plugins.every(
      (plugin) => typeof plugin === "object" && plugin !== null && typeof plugin.name === "string",
    )
  );
};

const render = (event: TurnEvent): void => {
  switch (event.type) {
    case "model-output":
      process.stdout.write(event.text);
      break;
    case "tool-call":
      process.stdout.write(`\n[tool ${event.name}]\n`);
      break;
    case "tool-result":
      process.stdout.write(`\n[tool ${event.name} ${event.isFailure ? "failed" : "completed"}]\n`);
      break;
    case "response-complete":
      process.stdout.write("\n");
      break;
  }
};

const errorMessage = (error: unknown): string => {
  const head =
    typeof error === "object" && error !== null && "_tag" in error && "message" in error
      ? `${String(error._tag)}: ${String(error.message)}`
      : error instanceof Error
        ? error.message
        : String(error);
  const cause =
    typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  return cause === undefined ? head : `${head}\n  cause: ${errorMessage(cause)}`;
};

if (!isDefinition(loaded)) {
  throw new Error("Definition must default-export an Agent with instructions, model, and Plugins.");
}

const { Cause, Effect, Exit, Fiber, Stream } = effect;

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* core.createSession(loaded);
    const lines = Stream.fromAsyncIterable(
      createInterface({ input: process.stdin, crlfDelay: Infinity }),
      (error) => error,
    );
    yield* Stream.runForEach(lines, (text) =>
      Stream.runForEach(session.prompt(text), (event) => Effect.sync(() => render(event))).pipe(
        // A failed Turn is reported but keeps the Session usable for the next line.
        Effect.catch((error) =>
          Effect.sync(() => process.stderr.write(`${errorMessage(error)}\n`)),
        ),
      ),
    );
  }),
);

const root = Effect.runFork(program);
let forceExit: ReturnType<typeof setTimeout> | undefined;
const interrupt = (): void => {
  // Backstop so a hung Session finalizer cannot hang Ctrl-C: cleanup gets 1s, then exit 124.
  forceExit ??= setTimeout(() => process.exit(124), 1_000);
  Effect.runFork(Fiber.interrupt(root));
};
process.on("SIGINT", interrupt);
const exit = await Effect.runPromiseExit(Fiber.join(root));
process.off("SIGINT", interrupt);
if (forceExit !== undefined) {
  clearTimeout(forceExit);
  process.exit(130);
}
if (Exit.isFailure(exit)) {
  process.stderr.write(`${errorMessage(Cause.squash(exit.cause))}\n`);
  process.exitCode = 1;
}
