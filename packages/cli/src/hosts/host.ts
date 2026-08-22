// Runs inside the embedded Bun runtime with the composition-root path as argv[1].
// child-host.ts embeds this file as text and never bundles it: dependencies are
// resolved beside the selected root so it shares the author's module instances.
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { MitomeDefinition, TurnEvent } from "@mitome/core";

const definitionPath = process.argv[1]!;
const mode = process.argv[2] as "auto" | "print";
// Absent when no prompt was given; an explicitly empty prompt arrives as "".
const prompt: string | undefined = process.argv[3];
const loaded: unknown = (
  (await import(pathToFileURL(definitionPath).href)) as { readonly default: unknown }
).default;

const isMitomeDefinition = (value: unknown): value is MitomeDefinition =>
  typeof value === "object" &&
  value !== null &&
  "agent" in value &&
  typeof value.agent === "object" &&
  value.agent !== null &&
  "hosts" in value &&
  Array.isArray(value.hosts) &&
  value.hosts.length <= 1 &&
  value.hosts.every(
    (host) =>
      typeof host === "object" &&
      host !== null &&
      "mode" in host &&
      host.mode === "interactive" &&
      "run" in host &&
      typeof host.run === "function",
  );

if (!isMitomeDefinition(loaded)) {
  throw new Error("The selected module must default-export defineMitome({ agent, hosts }).");
}

const interactiveHost = loaded.hosts[0];
if (mode === "auto" && interactiveHost !== undefined) {
  const reason = interactiveHost.unsupported?.();
  if (reason === undefined) {
    await interactiveHost.run({ agent: loaded.agent, prompt: prompt ?? "" });
    process.exit(0);
  }
  process.stderr.write(`${reason}; falling back to one-shot output.\n`);
}

// One-shot has nothing to run without a prompt; an explicitly empty prompt is
// still a valid Session input.
if (prompt === undefined) {
  process.stderr.write("Missing argument prompt\n");
  process.exit(1);
}

const render = (event: TurnEvent): void => {
  switch (event.type) {
    case "model-output":
      process.stdout.write(event.text);
      break;
    case "reasoning":
      break;
    case "tool-call":
      process.stdout.write(`\n[tool ${event.name}]\n`);
      break;
    case "tool-result":
      process.stdout.write(`\n[tool ${event.name} ${event.isFailure ? "failed" : "completed"}]\n`);
      break;
    case "approval-required":
      process.stdout.write(`\n[approval ${event.name} auto-approved]\n`);
      break;
    case "response-complete":
      process.stdout.write("\n");
      break;
    default:
      event satisfies never;
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

const corePath = Bun.resolveSync("@mitome/core", dirname(definitionPath));
const effectPath = Bun.resolveSync("effect", dirname(corePath));
const core: typeof import("@mitome/core") = await import(pathToFileURL(corePath).href);
const effect: typeof import("effect") = await import(pathToFileURL(effectPath).href);
const { Cause, Effect, Exit, Fiber, Stream } = effect;
const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* core.createSession(loaded.agent);
    yield* Stream.runForEach(session.prompt(prompt), (event) =>
      Effect.gen(function* () {
        render(event);
        if (event.type === "approval-required") yield* event.approve();
      }),
    );
  }),
);

const root = Effect.runFork(program);
let forceExit: ReturnType<typeof setTimeout> | undefined;
const interrupt = (): void => {
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
