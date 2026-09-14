// Runs inside the embedded Bun runtime with the composition-root path as argv[1].
// child-host.ts embeds this file as text and never bundles it: dependencies are
// resolved beside the selected root so it shares the author's module instances.
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChannelHost, Host, MitomeDefinition, TurnEvent } from "@mitome/core";
import { errorMessage } from "./diagnostics.js";

const definitionPath = process.argv[1]!;
const mode = process.argv[2];
if (mode !== "auto" && mode !== "print" && mode !== "serve") {
  throw new Error("Invalid Child Host mode.");
}
// Absent when no message was given; an explicitly empty message arrives as "".
// In serve mode this is the listener port instead.
const message: string | undefined = process.argv[3];
// SAFETY: Dynamic import namespaces expose their module's default export at `.default`.
const loaded: unknown = (
  (await import(pathToFileURL(definitionPath).href)) as { readonly default: unknown }
).default;

interface TranscriptStoreCandidate {
  readonly save?: unknown;
  readonly load?: unknown;
  readonly list?: unknown;
  readonly appendEvent?: unknown;
}

interface DefinitionCandidate {
  readonly agent?: object;
  readonly hosts?: ReadonlyArray<unknown>;
  readonly transcripts?: TranscriptStoreCandidate | undefined;
}

interface HostCandidate {
  readonly kind?: unknown;
  readonly name?: unknown;
  readonly run?: unknown;
  readonly unsupported?: unknown;
  readonly handle?: unknown;
  readonly serve?: unknown;
}

const isTranscriptStore = (value: TranscriptStoreCandidate): boolean =>
  value.save instanceof Function &&
  value.load instanceof Function &&
  value.list instanceof Function &&
  value.appendEvent instanceof Function;

const hasOptionalFunction = (
  host: HostCandidate,
  member: "unsupported" | "handle" | "serve",
): boolean => host[member] === undefined || host[member] instanceof Function;

// Mirrors hostIssue in @mitome/core's host.ts, which this file cannot import.
const hostIssue = (host: Host, index: number): string | undefined => {
  if (!(host instanceof Object) || host instanceof Function) {
    return `Host at index ${index} must be an object with a kind — did you forget to call the factory?`;
  }
  const candidate: HostCandidate = host;
  if (candidate.kind === undefined) {
    return `Host at index ${index} must be an object with a kind — did you forget to call the factory?`;
  }
  if (candidate.kind === "interactive") {
    return candidate.run instanceof Function && hasOptionalFunction(candidate, "unsupported")
      ? undefined
      : `Interactive Host at index ${index} must have a run function and optional unsupported function.`;
  }
  if (candidate.kind === "channel") {
    // Object() boxes only primitive strings and never invokes user coercion (lint bans typeof).
    if (
      !(Object(candidate.name) instanceof String) ||
      candidate.name instanceof String ||
      candidate.name === ""
    ) {
      return `Channel Host at index ${index} must have a non-empty string name.`;
    }
    // URL parsing collapses "." and ".." path segments, so serve mode could never mount them.
    if (candidate.name === "." || candidate.name === "..") {
      return `Channel Host at index ${index} must not be named "." or "..".`;
    }
    // encodeURIComponent throws on a lone surrogate, so the mount announcement could never print it.
    if (!String(candidate.name).isWellFormed()) {
      return `Channel Host at index ${index} must have a well-formed name without lone surrogates.`;
    }
    return hasOptionalFunction(candidate, "handle") &&
      hasOptionalFunction(candidate, "serve") &&
      (candidate.handle !== undefined || candidate.serve !== undefined)
      ? undefined
      : `Channel Host "${String(candidate.name)}" must expose a handle or serve function.`;
  }
  // Only primitive strings are echoed; JSON.stringify would throw on bigint or cyclic kinds.
  return Object(candidate.kind) instanceof String && !(candidate.kind instanceof String)
    ? `Host at index ${index} has unknown kind ${JSON.stringify(candidate.kind)}; expected "interactive" or "channel".`
    : `Host at index ${index} has a non-string kind; expected "interactive" or "channel".`;
};

const isMitomeDefinition = (value: DefinitionCandidate): value is MitomeDefinition =>
  "agent" in value &&
  value.agent instanceof Object &&
  "hosts" in value &&
  Array.isArray(value.hosts) &&
  (value.transcripts === undefined ||
    (value.transcripts instanceof Object && isTranscriptStore(value.transcripts)));

if (!(loaded instanceof Object) || !isMitomeDefinition(loaded)) {
  throw new Error("The selected module must default-export defineMitome({ agent, hosts }).");
}
const channelNames = new Set<string>();
loaded.hosts.forEach((host, index) => {
  const issue = hostIssue(host, index);
  if (issue !== undefined) throw new Error(issue);
  if (host.kind !== "channel") return;
  if (channelNames.has(host.name)) {
    throw new Error(`Channel Host name "${host.name}" is declared more than once.`);
  }
  channelNames.add(host.name);
});

const describeFailure = (cause: unknown): string =>
  cause instanceof Object ? errorMessage(cause) : String(cause);

if (mode === "serve") {
  const port = Number(message);
  const channels = loaded.hosts.filter((host) => host.kind === "channel");
  if (channels.length === 0) {
    process.stderr.write(
      "The Mitome Definition declares no Channel Hosts; mitome serve has nothing to run.\n",
    );
    process.exit(1);
  }
  const context = { agent: loaded.agent, transcripts: loaded.transcripts };
  const handlers = new Map<string, NonNullable<ChannelHost["handle"]>>();
  // Bound so a method-syntax handle sees its Channel as `this`, as serve does below.
  for (const channel of channels) {
    if (channel.handle !== undefined) handlers.set(channel.name, channel.handle.bind(channel));
  }
  // Channel names may contain spaces or Unicode, so the first segment arrives percent-encoded.
  const decodeMount = (segment: string): string | undefined => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return undefined;
    }
  };
  const listen = () => {
    try {
      return Bun.serve({
        port,
        fetch: (request) => {
          const url = new URL(request.url);
          const [, segment = "", ...rest] = url.pathname.split("/");
          const name = decodeMount(segment);
          const handle = name === undefined ? undefined : handlers.get(name);
          if (handle === undefined) return new Response("Not Found", { status: 404 });
          url.pathname = `/${rest.join("/")}`;
          return handle(context, new Request(url.href, request));
        },
      });
    } catch (error) {
      const mounted = [...handlers.keys()].map((name) => `"${name}"`).join(", ");
      process.stderr.write(
        `Cannot listen on port ${port} for Channel ${mounted}: ${describeFailure(error)}\n`,
      );
      process.exit(1);
    }
  };
  // A listener that fails to bind ends the process before any Channel runs.
  const server = handlers.size === 0 ? undefined : listen();
  const controller = new AbortController();
  const running = new Map<string, Promise<void>>();
  // Pending Promises alone do not keep the event loop alive until a signal arrives.
  const keepAlive = setInterval(() => {}, 60_000);
  let forceExit: ReturnType<typeof setTimeout> | undefined;
  const shutdown = async (exitCode: number): Promise<never> => {
    controller.abort();
    clearInterval(keepAlive);
    forceExit ??= setTimeout(() => process.exit(124), 5_000);
    // Active connections close so response bodies release their Session scopes.
    await Promise.all([server?.stop(true), ...running.values()]);
    process.exit(exitCode);
  };
  // 130 matches the one-shot Runner and the parent CLI's interrupt status.
  process.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(130));

  let startupFailure: string | undefined;
  for (const channel of channels) {
    if (channel.serve === undefined) continue;
    const { name } = channel;
    let started: Promise<void>;
    try {
      // A serve that returns a plain value instead of a Promise counts as stopping at once.
      started = Promise.resolve(channel.serve(context, controller.signal));
    } catch (error) {
      startupFailure = `Channel "${name}" failed to start: ${describeFailure(error)}`;
      break;
    }
    // A rejection or early return after start is a runtime failure: the others keep running.
    running.set(
      name,
      started
        .then(
          () => {
            if (!controller.signal.aborted) {
              process.stderr.write(`Channel "${name}" stopped before shutdown.\n`);
            }
          },
          (error) => {
            process.stderr.write(`Channel "${name}" failed: ${describeFailure(error)}\n`);
          },
        )
        .finally(() => {
          running.delete(name);
          if (running.size === 0 && server === undefined && !controller.signal.aborted) {
            process.stderr.write("No Channel is left running.\n");
            void shutdown(1);
          }
        }),
    );
  }
  if (startupFailure !== undefined) {
    process.stderr.write(`${startupFailure}\n`);
    await shutdown(1);
  }
  for (const channel of channels) {
    const mount =
      server !== undefined && channel.handle !== undefined
        ? ` at http://localhost:${server.port}/${encodeURIComponent(channel.name)}`
        : "";
    process.stderr.write(`Serving Channel "${channel.name}"${mount}\n`);
  }
  await new Promise<never>(() => {});
}

if (mode === "auto") {
  const interactive = loaded.hosts.filter((host) => host.kind === "interactive");
  for (const [index, host] of interactive.entries()) {
    const reason = host.unsupported?.();
    if (reason === undefined) {
      await host.run({
        agent: loaded.agent,
        message: message ?? "",
        transcripts: loaded.transcripts,
      });
      process.exit(0);
    }
    const fallback =
      index + 1 < interactive.length ? "trying the next Host" : "falling back to one-shot output";
    process.stderr.write(`${reason}; ${fallback}.\n`);
  }
}

// One-shot has nothing to run without a message; an explicitly empty message is
// still a valid Session input.
if (message === undefined) {
  process.stderr.write(
    "Missing argument message (one-shot output needs a message; interactive Sessions need a TTY without --print)\n",
  );
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

const corePath = Bun.resolveSync("@mitome/core", dirname(definitionPath));
const effectPath = Bun.resolveSync("effect", dirname(corePath));
const core: typeof import("@mitome/core") = await import(pathToFileURL(corePath).href);
const effect: typeof import("effect") = await import(pathToFileURL(effectPath).href);
const { Cause, Effect, Exit, Fiber, Stream } = effect;
const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* core.createHostSession({
      agent: loaded.agent,
      transcripts: loaded.transcripts,
    });
    yield* Stream.runForEach(session.runTurn(message), (event) =>
      Effect.gen(function* () {
        render(event);
        if (event.type === "approval-required") yield* event.approve();
      }),
    );
  }),
);

let forceExit: ReturnType<typeof setTimeout> | undefined;
const interrupt = (): void => {
  forceExit ??= setTimeout(() => process.exit(124), 1_000);
  Effect.runFork(Fiber.interrupt(root));
};
// Registered before the fork: runFork runs the Turn synchronously up to the first async
// boundary, so output can reach the parent before this line. Signals dispatch from the
// event loop, so `root` is assigned before interrupt can run.
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const root = Effect.runFork(program);
const exit = await Effect.runPromiseExit(Fiber.join(root));
process.off("SIGINT", interrupt);
process.off("SIGTERM", interrupt);
if (forceExit !== undefined) {
  clearTimeout(forceExit);
  process.exit(130);
}
if (Exit.isFailure(exit)) {
  process.stderr.write(`${describeFailure(Cause.squash(exit.cause))}\n`);
  process.exitCode = 1;
}
