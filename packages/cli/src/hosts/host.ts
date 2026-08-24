// Runs inside the embedded Bun runtime with the composition-root path as argv[1].
// child-host.ts embeds this file as text and never bundles it: dependencies are
// resolved beside the selected root so it shares the author's module instances.
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { MitomeDefinition, TurnEvent } from "@mitome/core";

const definitionPath = process.argv[1]!;
const mode = process.argv[2];
if (mode !== "auto" && mode !== "print") throw new Error("Invalid Child Host mode.");
// Absent when no prompt was given; an explicitly empty prompt arrives as "".
const prompt: string | undefined = process.argv[3];
// SAFETY: Dynamic import namespaces expose their module's default export at `.default`.
const loaded: unknown = (
  (await import(pathToFileURL(definitionPath).href)) as { readonly default: unknown }
).default;

interface DefinitionCandidate {
  readonly agent?: object;
  readonly hosts?: ReadonlyArray<object>;
}

const isMitomeDefinition = (value: DefinitionCandidate): value is MitomeDefinition =>
  "agent" in value &&
  value.agent instanceof Object &&
  "hosts" in value &&
  Array.isArray(value.hosts) &&
  value.hosts.length <= 1 &&
  value.hosts.every(
    (host) =>
      host instanceof Object &&
      "mode" in host &&
      host.mode === "interactive" &&
      "run" in host &&
      host.run instanceof Function &&
      (!("unsupported" in host) ||
        host.unsupported === undefined ||
        host.unsupported instanceof Function),
  );

if (!(loaded instanceof Object)) {
  throw new Error("The selected module must default-export defineMitome({ agent, hosts }).");
}
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

interface ErrorDetails {
  readonly _tag?: string;
  readonly message?: string;
  readonly cause?: Error | ErrorDetails;
}

// JSON.stringify throws on BigInt values and circular structures; a throwing
// formatter would mask the error being reported, so fall back to Bun's renderer.
const safeJson = (value: Error | ErrorDetails | null): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return Bun.inspect(value);
  }
};

const errorMessage = (error: Error | ErrorDetails): string => {
  const head =
    "_tag" in error && "message" in error
      ? `${String(error._tag)}: ${String(error.message)}`
      : error instanceof Error
        ? error.message
        : safeJson(error);
  const cause = error.cause;
  if (cause === undefined) return head;
  return `${head}\n  cause: ${cause !== null && cause instanceof Object ? errorMessage(cause) : safeJson(cause)}`;
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
  const squashed = Cause.squash(exit.cause);
  if (!(squashed instanceof Object)) {
    process.stderr.write(`${String(squashed)}\n`);
  } else {
    process.stderr.write(`${errorMessage(squashed)}\n`);
  }
  process.exitCode = 1;
}
