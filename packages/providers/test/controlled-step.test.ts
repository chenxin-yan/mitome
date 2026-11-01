import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Predicate,
  Schema,
  SchemaGetter,
  Scope,
} from "effect";
import { type LanguageModel, Prompt, Tool, Toolkit } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { WebSocketServer } from "ws";
import {
  firstPartyExecutionLimits,
  type ExecutionUsage,
  localTools,
  loop,
  makeSession,
  type ModelRequestAccounting,
  providerModel,
  step,
  Turn,
} from "@mitome/core";
import { writeCredential } from "../src/openai-codex/credential-store.js";
import { codex } from "../src/openai-codex/index.js";
import { openaiCompatible } from "../src/openai-compatible/index.js";
import { openai } from "../src/openai/index.js";
import { runWithKey, sse } from "./support.js";

// Serial two-Tool fixtures through every first-party Provider binding, over real local HTTP (and
// WebSocket for OpenAI's default transport). Each binding's reported physical requests must equal
// the Model requests its server actually received; authentication requests are not Model requests.

type Json = Schema.Json;
const key = "MITOME_CONTROLLED_STEP_TEST_KEY";
const run = runWithKey(key);

class Quota extends Schema.TaggedError<Quota>()("Quota", {}) {}
const First = Tool.make("first", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
  failure: Quota,
});
const Second = Tool.make("second", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
  failure: Quota,
});
const Kit = Toolkit.make(First, Second);

/** What the scripted upstream answers to one Model request. */
type Reply =
  | "calls"
  | "text"
  | "incomplete"
  | "filtered"
  | "rejected"
  | "retryable"
  | "unauthorized"
  // Transport faults after the upstream received the request:
  | "dropped" // closes the connection before any response headers
  | "partial" // sends a complete call and a started call, then closes mid-body
  | "unterminated" // ends a complete two-call body without a terminal event
  | "hang"; // never answers

/** Applies a transport fault reply; returns false for ordinary replies. */
const transportFault = (reply: Reply, response: ServerResponse, partialBody: string) => {
  if (reply === "hang") return true;
  if (reply === "dropped") {
    response.socket?.destroy();
    return true;
  }
  if (reply === "partial") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(partialBody, () => response.socket?.destroy());
    return true;
  }
  return false;
};

interface Probe {
  readonly log: Array<string>;
  active: number;
  overlap: boolean;
}

const work = (probe: Probe, name: string, value: string, fails: boolean) =>
  Effect.gen(function* () {
    probe.active += 1;
    if (probe.active > 1) probe.overlap = true;
    probe.log.push(`${name}:start`);
    // Give a concurrent dispatcher every chance to overlap the next handler.
    for (let i = 0; i < 5; i++) yield* Effect.yieldNow;
    if (fails) return yield* new Quota();
    probe.log.push(`${name}:end`);
    return `${name}:${value}`;
  }).pipe(Effect.ensuring(Effect.sync(() => void (probe.active -= 1))));

interface Outcome {
  readonly exit: Exit.Exit<unknown, unknown>;
  readonly history: ReadonlyArray<{ readonly role: string }>;
  readonly usage: ExecutionUsage | undefined;
  readonly log: ReadonlyArray<string>;
  readonly overlap: boolean;
}

/**
 * One Turn through the public Session seam: stage input, run the default loop (or one Step for
 * `custom`) over the two Tools, and close a passive observer as soon as the first handler starts.
 */
const runTurn = (
  model: Layer.Layer<LanguageModel.LanguageModel | ModelRequestAccounting, unknown>,
  options: {
    readonly fail?: "first" | "second";
    readonly custom?: boolean;
    readonly toolChoice?: LanguageModel.GenerateTextOptions<
      Toolkit.Tools<typeof Kit>
    >["toolChoice"];
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const probe: Probe = { log: [], active: 0, overlap: false };
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let usage: ExecutionUsage | undefined;
      const session = yield* makeSession({
        persistence: "none",
        limits: firstPartyExecutionLimits,
      });
      const observers = yield* Scope.make();
      yield* session.observe(1).pipe(Scope.provide(observers));
      const program = Effect.gen(function* () {
        const tools = yield* localTools(
          Kit,
          Kit.of({
            first: ({ key: value }) =>
              Effect.andThen(
                Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release)),
                work(probe, "first", value, options.fail === "first"),
              ),
            second: ({ key: value }) => work(probe, "second", value, options.fail === "second"),
          }),
        );
        const turn = yield* Turn;
        yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: "go" })] }));
        const stepOptions = { tools, toolChoice: options.toolChoice };
        return options.custom === true ? yield* step(stepOptions) : yield* loop(stepOptions);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const turn = yield* Turn;
            usage = yield* turn.usage;
          }).pipe(Effect.orDie),
        ),
        Effect.provide(model),
      );
      const fiber = yield* Effect.forkChild(Effect.exit(session.run(program)));
      // The observer leaves early; execution must neither stop nor wait for it.
      yield* Effect.raceFirst(Deferred.await(started), Effect.asVoid(Fiber.await(fiber)));
      yield* Scope.close(observers, Exit.void);
      yield* Deferred.succeed(release, undefined);
      const exit = yield* Fiber.join(fiber);
      return {
        exit,
        history: yield* session.history,
        usage,
        log: probe.log,
        overlap: probe.overlap,
      } satisfies Outcome;
    }),
  );

const body = async (request: IncomingMessage): Promise<Record<string, Json>> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString();
  // Token refreshes are form-encoded; only JSON Model request bodies are inspected.
  return request.headers["content-type"]?.includes("json") === true && text !== ""
    ? Schema.decodeSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(text)
    : {};
};

interface Upstream {
  readonly url: string;
  /** Model requests received, with the path and parsed body of each. */
  readonly requests: Array<{ readonly path: string; readonly body: Record<string, Json> }>;
  /** Other requests (authentication), which are not Model requests. */
  readonly other: Array<string>;
  readonly upgrades: () => number;
  readonly stop: () => Promise<void>;
}

/**
 * A real local HTTP server answering Model requests at `modelPath` from `replies` in order, and
 * optionally a WebSocket endpoint at the same path for OpenAI's socket mode.
 */
const upstream = async (
  modelPath: string,
  replies: Array<Reply>,
  respond: (reply: Reply, response: ServerResponse) => void,
  other: (path: string, response: ServerResponse) => void = (_, response) =>
    void response.writeHead(404).end(),
): Promise<Upstream> => {
  const requests: Upstream["requests"] = [];
  const others: Array<string> = [];
  let upgrades = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const parsed = await body(request);
      if (path !== modelPath) {
        others.push(path);
        return other(path, response);
      }
      requests.push({ path, body: parsed });
      respond(replies.shift() ?? "text", response);
    })();
  });
  const sockets = new WebSocketServer({ server, path: modelPath });
  sockets.on("connection", () => void (upgrades += 1));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  // SAFETY: a successfully listening TCP server returns AddressInfo rather than null or a pipe name.
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    other: others,
    upgrades: () => upgrades,
    stop: () =>
      new Promise((resolve) => {
        sockets.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const json = (response: ServerResponse, status: number, value: Json) =>
  void response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));

// OpenAI Responses (non-streaming, as controlled generation uses).
const functionCall = (index: number, name: string, value: string) => ({
  type: "function_call",
  id: `fc-${index}`,
  call_id: `call-${index}`,
  name,
  arguments: JSON.stringify({ key: value }),
  status: "completed",
});
const openAiResponse = (
  id: string,
  output: ReadonlyArray<Json>,
  extra: Record<string, Json> = {},
) => ({
  id,
  object: "response",
  model: "gpt-5.6",
  created_at: 1,
  status: "completed",
  output,
  ...extra,
});
let responseCount = 0;
const openAiReply = (reply: Reply, response: ServerResponse) => {
  if (transportFault(reply, response, '{"id":"resp-partial","object":"response",')) return;
  responseCount += 1;
  const id = `resp-${responseCount}`;
  if (reply === "calls") {
    return json(
      response,
      200,
      openAiResponse(id, [functionCall(1, "first", "a"), functionCall(2, "second", "b")]),
    );
  }
  if (reply === "filtered") {
    return json(
      response,
      200,
      openAiResponse(id, [functionCall(1, "first", "a")], {
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
      }),
    );
  }
  if (reply === "rejected") {
    return json(response, 400, {
      error: { type: "invalid_request_error", message: "previous response not found" },
    });
  }
  return json(
    response,
    200,
    openAiResponse(id, [
      {
        type: "message",
        id: `msg-${responseCount}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "done", annotations: [] }],
      },
    ]),
  );
};

// OpenAI-compatible Chat Completions (non-streaming).
const compatibleReply = (reply: Reply, response: ServerResponse) => {
  const toolCall = (index: number, name: string, value: string) => ({
    id: `call-${index}`,
    type: "function",
    function: { name, arguments: JSON.stringify({ key: value }) },
  });
  const completion = (finishReason: string, message: Record<string, Json>) => ({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "local-model",
    choices: [
      { index: 0, finish_reason: finishReason, message: { role: "assistant", ...message } },
    ],
  });
  if (reply === "calls") {
    return json(
      response,
      200,
      completion("tool_calls", {
        content: null,
        tool_calls: [toolCall(1, "first", "a"), toolCall(2, "second", "b")],
      }),
    );
  }
  if (reply === "incomplete") {
    return json(
      response,
      200,
      completion("length", { content: null, tool_calls: [toolCall(1, "first", "a")] }),
    );
  }
  return json(response, 200, completion("stop", { content: "done" }));
};

// Codex SSE (its generateText collects the complete stream).
const codexReply = (reply: Reply, response: ServerResponse) => {
  if (reply === "retryable") return void response.writeHead(503).end("busy");
  if (reply === "unauthorized") return void response.writeHead(401).end("");
  const call = (index: number, name: string, value: string) =>
    sse({
      type: "response.output_item.added",
      output_index: index,
      item: { type: "function_call", call_id: `call-${index}`, name },
    }) +
    sse({
      type: "response.output_item.done",
      output_index: index,
      item: { type: "function_call", arguments: JSON.stringify({ key: value }) },
    });
  const text =
    sse({ type: "response.output_item.added", output_index: 0, item: { type: "message" } }) +
    sse({ type: "response.output_text.delta", output_index: 0, delta: "done" }) +
    sse({ type: "response.output_item.done", output_index: 0, item: { type: "message" } }) +
    sse({ type: "response.completed" });
  const truncated =
    call(0, "first", "a") +
    sse({
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } },
    });
  const started = sse({
    type: "response.output_item.added",
    output_index: 1,
    item: { type: "function_call", call_id: "call-1", name: "second" },
  });
  if (transportFault(reply, response, call(0, "first", "a") + started)) return;
  const both = call(0, "first", "a") + call(1, "second", "b") + sse({ type: "response.completed" });
  const events = Match.value(reply).pipe(
    Match.when("unterminated", () => call(0, "first", "a") + call(1, "second", "b")),
    Match.when("calls", () => both),
    Match.when("incomplete", () => truncated),
    Match.orElse(() => text),
  );
  response.writeHead(200, { "content-type": "text/event-stream" }).end(events);
};

const directories: Array<string> = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});
const jwt = (accountId: string) =>
  `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: accountId })).toString("base64url")}.signature`;
const codexDirectory = async (expires = Date.now() + 3_600_000) => {
  const configDirectory = await mkdtemp(join(tmpdir(), "mitome-controlled-step-"));
  directories.push(configDirectory);
  await Effect.runPromise(
    writeCredential(configDirectory, {
      type: "oauth",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires,
      accountId: "synthetic-account",
    }),
  );
  return configDirectory;
};
const tokenEndpoint = (fails: boolean) => (path: string, response: ServerResponse) => {
  if (path !== "/oauth/token") return void response.writeHead(404).end();
  if (fails) return json(response, 400, { error: "invalid_grant" });
  json(response, 200, {
    access_token: jwt("synthetic-account"),
    refresh_token: "rotated-refresh",
    expires_in: 3_600,
  });
};

interface Binding {
  readonly name: string;
  readonly modelPath: string;
  readonly respond: (reply: Reply, response: ServerResponse) => void;
  readonly model: (
    server: Upstream,
  ) => Promise<Layer.Layer<LanguageModel.LanguageModel | ModelRequestAccounting, unknown>>;
}

const bindings: ReadonlyArray<Binding> = [
  {
    name: "openai (HTTP transport)",
    modelPath: "/v1/responses",
    respond: openAiReply,
    model: async (server) =>
      providerModel(
        openai({ apiKeyEnv: key, baseUrl: `${server.url}/v1`, transport: "http" }),
        "gpt-5.6",
      ),
  },
  {
    name: "openai (default WebSocket transport)",
    modelPath: "/v1/responses",
    respond: openAiReply,
    model: async (server) =>
      providerModel(openai({ apiKeyEnv: key, baseUrl: `${server.url}/v1` }), "gpt-5.6"),
  },
  {
    name: "openai-compatible",
    modelPath: "/v1/chat/completions",
    respond: compatibleReply,
    model: async (server) =>
      providerModel(
        openaiCompatible({ id: "compatible", apiKeyEnv: key, baseUrl: `${server.url}/v1` }),
        "local-model",
      ),
  },
  {
    name: "openai-codex",
    modelPath: "/codex/responses",
    respond: codexReply,
    model: async (server) =>
      providerModel(
        codex({
          configDirectory: await codexDirectory(),
          baseUrl: server.url,
          tokenUrl: `${server.url}/oauth/token`,
        }),
        "gpt-5.4",
      ),
  },
];

const squashed = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe.each(bindings)("controlled Step through $name", (binding) => {
  const withUpstream = async <A>(
    replies: Array<Reply>,
    use: (
      server: Upstream,
      model: Layer.Layer<LanguageModel.LanguageModel | ModelRequestAccounting, unknown>,
    ) => Promise<A>,
  ) => {
    const server = await upstream(
      binding.modelPath,
      replies,
      binding.respond,
      tokenEndpoint(false),
    );
    try {
      return await use(server, await binding.model(server));
    } finally {
      await server.stop();
    }
  };

  it("runs two Tool Calls serially, continues and commits once, counting every request", () =>
    withUpstream(["calls", "text"], async (server, model) => {
      const outcome = await run(runTurn(model));
      expect(Exit.isSuccess(outcome.exit)).toBe(true);
      expect(outcome.log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
      expect(outcome.overlap).toBe(false);
      expect(outcome.history.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
      ]);
      expect(outcome.usage).toEqual({
        generations: 2,
        dispatches: 2,
        physicalRequests: server.requests.length,
      });
      expect(server.requests.length).toBe(2);
      expect(server.other).toEqual([]);
    }));

  it("keeps the first Tool's typed failure, never runs the second and commits nothing", () =>
    withUpstream(["calls", "text"], async (server, model) => {
      const outcome = await run(runTurn(model, { fail: "first" }));
      expect(squashed(outcome.exit)).toBeInstanceOf(Quota);
      expect(outcome.log).toEqual(["first:start"]);
      expect(outcome.history).toEqual([]);
      expect(outcome.usage).toEqual({ generations: 1, dispatches: 1, physicalRequests: 1 });
      expect(server.requests.length).toBe(1);
    }));

  it("keeps the second Tool's typed failure after the first effect, committing nothing", () =>
    withUpstream(["calls", "text"], async (_, model) => {
      const outcome = await run(runTurn(model, { fail: "second" }));
      expect(squashed(outcome.exit)).toBeInstanceOf(Quota);
      expect(outcome.log).toEqual(["first:start", "first:end", "second:start"]);
      expect(outcome.history).toEqual([]);
      expect(outcome.usage).toEqual({ generations: 1, dispatches: 2, physicalRequests: 1 });
    }));

  // Upstream @effect/ai-openai 4.0.0 does not map `max_output_tokens`, so the openai bindings read
  // this truncated response as Tool calls; only the other bindings report it as incomplete.
  if (!binding.name.startsWith("openai (")) {
    it("returns explicit incomplete output without dispatch; the default loop fails", () =>
      withUpstream(["incomplete", "incomplete"], async (_, model) => {
        const custom = await run(runTurn(model, { custom: true }));
        expect(custom.log).toEqual([]);
        expect(Exit.isSuccess(custom.exit) && custom.exit.value).toMatchObject({
          _tag: "Incomplete",
          reason: "length",
        });
        // Only the program's own staged input commits; the Step staged nothing.
        expect(custom.history.map((message) => message.role)).toEqual(["user"]);
        const looped = await run(runTurn(model));
        expect(squashed(looped.exit)).toMatchObject({
          _tag: "IncompleteStepError",
          reason: "length",
        });
        expect(looped.log).toEqual([]);
      }));
  }
});

describe.each(bindings.filter((binding) => binding.name.startsWith("openai (")))(
  "OpenAI finish controls through $name",
  (binding) => {
    const incompleteStep = async (reply: Reply) => {
      const server = await upstream(binding.modelPath, [reply, reply], binding.respond);
      try {
        const model = await binding.model(server);
        return {
          custom: await run(runTurn(model, { custom: true })),
          looped: await run(runTurn(model)),
        };
      } finally {
        await server.stop();
      }
    };

    it("keeps a content-filtered response with calls incomplete", async () => {
      const { custom, looped } = await incompleteStep("filtered");
      expect(custom.log).toEqual([]);
      expect(Exit.isSuccess(custom.exit) && custom.exit.value).toMatchObject({
        _tag: "Incomplete",
        reason: "content-filter",
      });
      expect(custom.history.map((message) => message.role)).toEqual(["user"]);
      expect(squashed(looped.exit)).toMatchObject({ reason: "content-filter" });
      expect(looped.log).toEqual([]);
    });
  },
);

describe("Codex response.incomplete without details", () => {
  const events = (withCall: boolean, terminal: Record<string, Json>) =>
    (withCall
      ? sse({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", call_id: "call-0", name: "first" },
        }) +
        sse({
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "function_call", arguments: JSON.stringify({ key: "a" }) },
        })
      : sse({ type: "response.output_item.added", output_index: 0, item: { type: "message" } }) +
        sse({ type: "response.output_text.delta", output_index: 0, delta: "par" })) + sse(terminal);
  const turn = async (body: string, custom: boolean) => {
    const server = await upstream(
      "/codex/responses",
      ["text"],
      (_, response) =>
        void response.writeHead(200, { "content-type": "text/event-stream" }).end(body),
    );
    try {
      const model = providerModel(
        codex({
          configDirectory: await codexDirectory(),
          baseUrl: server.url,
          tokenUrl: `${server.url}/oauth/token`,
        }),
        "gpt-5.4",
      );
      return await run(runTurn(model, { custom }));
    } finally {
      await server.stop();
    }
  };

  it.each([
    ["no response", { type: "response.incomplete" }],
    ["null details", { type: "response.incomplete", response: { incomplete_details: null } }],
    ["empty details", { type: "response.incomplete", response: { incomplete_details: {} } }],
  ])(
    "keeps a response.incomplete with %s incomplete and dispatches nothing",
    async (_, terminal) => {
      for (const withCall of [true, false]) {
        const body = events(withCall, terminal);
        const custom = await turn(body, true);
        expect(custom.log).toEqual([]);
        expect(Exit.isSuccess(custom.exit) && custom.exit.value).toMatchObject({
          _tag: "Incomplete",
          reason: "unknown",
        });
        expect(custom.history.map((entry) => entry.role)).toEqual(["user"]);
        const looped = await turn(body, false);
        expect(squashed(looped.exit)).toMatchObject({
          _tag: "IncompleteStepError",
          reason: "unknown",
        });
        expect(looped.log).toEqual([]);
      }
    },
  );

  it.each([
    ["with its message", { message: "cancelled by operator" }, "cancelled by operator"],
    ["without a message", undefined, "Codex response was cancelled by the provider"],
  ])(
    "fails a provider-cancelled response %s, without dispatch or interruption",
    async (_, error, description) => {
      for (const type of ["response.completed", "response.done"]) {
        const response =
          error === undefined ? { status: "cancelled" } : { status: "cancelled", error };
        for (const custom of [true, false]) {
          const outcome = await turn(events(true, { type, response }), custom);
          expect(outcome.log).toEqual([]);
          expect(outcome.history).toEqual([]);
          expect(Exit.isFailure(outcome.exit) && Cause.hasInterruptsOnly(outcome.exit.cause)).toBe(
            false,
          );
          expect(squashed(outcome.exit)).toMatchObject({
            _tag: "AiError",
            reason: { _tag: "UnknownError", description },
          });
          expect(outcome.usage).toEqual({ generations: 1, dispatches: 0, physicalRequests: 1 });
        }
      }
    },
  );

  it("does not dispatch from a completed or done event with a non-success status", async () => {
    for (const type of ["response.completed", "response.done"]) {
      const incomplete = await turn(
        events(true, { type, response: { status: "incomplete" } }),
        true,
      );
      expect(incomplete.log).toEqual([]);
      expect(Exit.isSuccess(incomplete.exit) && incomplete.exit.value).toMatchObject({
        _tag: "Incomplete",
        reason: "unknown",
      });
      const failed = await turn(
        events(true, { type, response: { status: "failed", error: { message: "boom" } } }),
        true,
      );
      expect(failed.log).toEqual([]);
      expect(failed.history).toEqual([]);
      expect(Exit.isFailure(failed.exit) && Cause.hasInterruptsOnly(failed.exit.cause)).toBe(false);
      expect(squashed(failed.exit)).toMatchObject({
        _tag: "AiError",
        reason: { _tag: "UnknownError", description: "boom" },
      });
    }
  });

  it("still completes a response.completed or response.done without details", async () => {
    for (const type of ["response.completed", "response.done"]) {
      const outcome = await turn(events(true, { type }), true);
      expect(outcome.log).toEqual(["first:start", "first:end"]);
      expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
        _tag: "Complete",
      });
    }
  });
});

describe.each(bindings)("Void Tool results through $name", (binding) => {
  // Same names as the fixture's Tools, but with the native default `Schema.Void` success.
  const VoidKit = Toolkit.make(
    Tool.make("first", { parameters: Schema.Struct({ key: Schema.String }) }),
    Tool.make("second", { parameters: Schema.Struct({ key: Schema.String }) }),
  );
  /** Every Tool output the continuation request sends back, as the wire carries it. */
  const FunctionOutput = Schema.Struct({
    type: Schema.Literal("function_call_output"),
    output: Schema.optional(Schema.Json),
  });
  const ToolMessage = Schema.Struct({
    role: Schema.Literal("tool"),
    content: Schema.optional(Schema.Json),
  });
  const JsonArray = Schema.Array(Schema.Json);
  const JsonRecord = Schema.Record(Schema.String, Schema.Json);
  const toolOutputs = (value: Json): Array<Json | undefined> => {
    if (Schema.is(FunctionOutput)(value)) return [value.output];
    if (Schema.is(ToolMessage)(value)) return [value.content];
    if (Schema.is(JsonArray)(value)) return value.flatMap(toolOutputs);
    if (Schema.is(JsonRecord)(value)) return Object.values(value).flatMap(toolOutputs);
    return [];
  };

  it("sends a Void result back as JSON null, returns it natively and saves it as null", async () => {
    const server = await upstream(binding.modelPath, ["calls", "text"], binding.respond);
    try {
      const model = await binding.model(server);
      const saved: Array<ReadonlyArray<Prompt.Message>> = [];
      const outcome = await run(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeSession({
              limits: firstPartyExecutionLimits,
              persistence: { save: (history) => Effect.sync(() => void saved.push(history)) },
            });
            const tools = yield* localTools(VoidKit, {
              first: () => Effect.void,
              second: () => Effect.void,
            });
            return yield* session.run(
              Effect.gen(function* () {
                const turn = yield* Turn;
                yield* turn.stage(
                  Prompt.userMessage({ content: [Prompt.textPart({ text: "go" })] }),
                );
                const first = yield* step({ tools });
                yield* step({ tools });
                return first;
              }).pipe(Effect.provide(model)),
            );
          }),
        ),
      );
      if (!Predicate.isTagged(outcome, "Complete")) throw new Error("expected a complete Step");
      expect(outcome.results.map((part) => [part.result, part.encodedResult])).toEqual([
        [undefined, undefined],
        [undefined, undefined],
      ]);
      const continuation = server.requests[1]?.body ?? {};
      expect(toolOutputs(continuation)).toEqual(["null", "null"]);
      const tool = (saved[0] ?? []).find(
        (message): message is Prompt.ToolMessage => message.role === "tool",
      );
      const results = (tool?.content ?? []).map((part) =>
        part.type === "tool-result" ? part.result : "missing",
      );
      expect(results).toEqual([null, null]);
    } finally {
      await server.stop();
    }
  });
});

// Upstream @effect/ai-openai and @effect/ai-openai-compat 4.0.0 re-encode Tool parameters through
// the application parameter schema, so only the Codex binding is covered here.
describe.each(bindings.filter((binding) => binding.name === "openai-codex"))(
  "parameter encoding services through $name",
  (binding) => {
    class ParamsEncoder extends Context.Service<ParamsEncoder, { readonly encoded: () => void }>()(
      "test/ParamsEncoder",
    ) {}
    // Decoding is pure; encoding needs ParamsEncoder, so the Step's type requires it.
    const EncodedKey = Schema.String.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((value: string) => value),
        encode: SchemaGetter.transformEffect((value: string) =>
          Effect.map(ParamsEncoder, (encoder) => (encoder.encoded(), value)),
        ),
      }),
    );
    const EncodedKit = Toolkit.make(
      Tool.make("first", {
        parameters: Schema.Struct({ key: EncodedKey }),
        success: Schema.String,
      }),
      Tool.make("second", {
        parameters: Schema.Struct({ key: EncodedKey }),
        success: Schema.String,
      }),
    );

    it("dispatches once without running the parameter encoder, whose service stays required", async () => {
      const server = await upstream(binding.modelPath, ["calls"], binding.respond);
      try {
        const model = await binding.model(server);
        const log: Array<string> = [];
        let encodes = 0;
        const outcome = await run(
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* makeSession({
                persistence: "none",
                limits: firstPartyExecutionLimits,
              });
              const tools = yield* localTools(EncodedKit, {
                first: () => Effect.sync(() => (log.push("first"), "a")),
                second: () => Effect.sync(() => (log.push("second"), "b")),
              });
              return yield* session.run(
                step({ tools }).pipe(
                  Effect.provide(model),
                  Effect.provideService(ParamsEncoder, { encoded: () => void encodes++ }),
                ),
              );
            }),
          ),
        );
        if (!Predicate.isTagged(outcome, "Complete")) throw new Error("expected a complete Step");
        expect(log).toEqual(["first", "second"]);
        // Codex normalizes parameters without the application codec, so it never runs the encoder;
        // the Step still requires its service (native R).
        expect(encodes).toBe(0);
      } finally {
        await server.stop();
      }
    });
  },
);

describe("Codex Tool call groups and Tool choice", () => {
  const added = (index: number, id: string, name = "first") =>
    sse({
      type: "response.output_item.added",
      output_index: index,
      item: { type: "function_call", id: `item-${index}`, call_id: id, name },
    });
  const doneAt = (index: number) =>
    sse({
      type: "response.output_item.done",
      output_index: index,
      item: { type: "function_call", arguments: JSON.stringify({ key: "a" }) },
    });
  // Finished through its item id alias only, as the backend may key events.
  const doneById = (index: number) =>
    sse({
      type: "response.output_item.done",
      item_id: `item-${index}`,
      item: { type: "function_call", id: `item-${index}`, arguments: JSON.stringify({ key: "b" }) },
    });
  const turn = async (
    body: string,
    options: Parameters<typeof runTurn>[1] = {},
  ): Promise<Outcome & { readonly requests: Upstream["requests"] }> => {
    const server = await upstream(
      "/codex/responses",
      ["text"],
      (_, response) =>
        void response.writeHead(200, { "content-type": "text/event-stream" }).end(body),
    );
    try {
      const model = providerModel(
        codex({
          configDirectory: await codexDirectory(),
          baseUrl: server.url,
          tokenUrl: `${server.url}/oauth/token`,
        }),
        "gpt-5.4",
      );
      const outcome = await run(runTurn(model, options));
      return { ...outcome, requests: server.requests };
    } finally {
      await server.stop();
    }
  };

  it("rejects a completed response with an unfinished call and dispatches none of its group", async () => {
    for (const type of ["response.completed", "response.done"]) {
      const body = added(0, "call-a") + doneAt(0) + added(1, "call-b", "second") + sse({ type });
      for (const custom of [true, false]) {
        const outcome = await turn(body, { custom });
        expect(outcome.log).toEqual([]);
        expect(outcome.history).toEqual([]);
        expect(squashed(outcome.exit)).toMatchObject({
          _tag: "AiError",
          reason: {
            _tag: "InvalidOutputError",
            description: "Codex completed a response with an unfinished Tool call",
          },
        });
        expect(outcome.usage).toEqual({ generations: 1, dispatches: 0, physicalRequests: 1 });
      }
    }
  });

  it.each([
    [
      "a call item finished with status incomplete",
      added(0, "call-a") +
        sse({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            arguments: JSON.stringify({ key: "a" }),
            status: "incomplete",
          },
        }),
      "Codex completed a response with an unfinished Tool call",
    ],
    [
      "a Provider web search item",
      sse({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "web_search_call", id: "ws-1", status: "completed" },
      }) +
        added(1, "call-a") +
        doneAt(1),
      "Codex returned an unrequested Provider Tool item (web_search_call)",
    ],
    [
      "a Provider approval request item",
      sse({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "mcp_approval_request",
          id: "ap-1",
          name: "x",
          arguments: "{}",
          server_label: "s",
        },
      }) +
        added(1, "call-a") +
        doneAt(1),
      "Codex returned an unrequested Provider Tool item (mcp_approval_request)",
    ],
  ])("fails a completed response with %s before any dispatch", async (_, items, description) => {
    const outcome = await turn(items + sse({ type: "response.completed" }), { custom: true });
    expect(outcome.log).toEqual([]);
    expect(outcome.history).toEqual([]);
    expect(squashed(outcome.exit)).toMatchObject({
      _tag: "AiError",
      reason: { _tag: "InvalidOutputError", description },
    });
  });

  const message = (index: number, done?: Record<string, Json>) =>
    sse({
      type: "response.output_item.added",
      output_index: index,
      item: { type: "message", id: `m${index}` },
    }) +
    sse({ type: "response.output_text.delta", output_index: index, delta: "partial" }) +
    (done === undefined
      ? ""
      : sse({
          type: "response.output_item.done",
          output_index: index,
          item: { type: "message", id: `m${index}`, ...done },
        }));
  const reasoning = (index: number, status: string) =>
    sse({
      type: "response.output_item.done",
      output_index: index,
      item: {
        type: "reasoning",
        id: `r${index}`,
        status,
        summary: [{ type: "summary_text", text: "partial" }],
      },
    });
  const doneWith = (index: number, identity: Record<string, string>) =>
    sse({
      type: "response.output_item.done",
      output_index: index,
      item: { type: "function_call", arguments: JSON.stringify({ key: "a" }), ...identity },
    });
  const listedCall = (identity: Record<string, string> = {}) => ({
    type: "function_call",
    id: "item-0",
    call_id: "call-a",
    name: "first",
    arguments: JSON.stringify({ key: "a" }),
    status: "completed",
    ...identity,
  });
  const completedWith = (output: typeof Schema.Json.Type) =>
    sse({ type: "response.completed", response: { status: "completed", output } });

  it.each([
    ["an open message", message(2), "Codex completed a response with unfinished output"],
    [
      "a message finished with status incomplete",
      message(2, { status: "incomplete" }),
      "Codex completed a response with unfinished output",
    ],
    [
      "reasoning finished with status in_progress",
      reasoning(2, "in_progress"),
      "Codex completed a response with unfinished output",
    ],
  ])(
    "fails a completed response whose call group has %s before any dispatch",
    async (_, extra, description) => {
      for (const type of ["response.completed", "response.done"]) {
        const outcome = await turn(added(0, "call-a") + doneAt(0) + extra + sse({ type }), {
          custom: true,
        });
        expect(outcome.log).toEqual([]);
        expect(outcome.history).toEqual([]);
        expect(squashed(outcome.exit)).toMatchObject({
          _tag: "AiError",
          reason: { _tag: "InvalidOutputError", description },
        });
        expect(outcome.usage).toEqual({ generations: 1, dispatches: 0, physicalRequests: 1 });
      }
    },
  );

  const startContradiction = "Codex completed a Tool call that contradicts its start";
  it.each([
    // The item id is a locator: a done item naming another item contradicts the event's index.
    ["item id", { id: "wrong-item" }, "Codex sent output events that contradict each other"],
    ["call id", { call_id: "wrong-call" }, startContradiction],
    ["Tool name", { name: "second" }, startContradiction],
  ])(
    "fails a call completion that contradicts its start's %s",
    async (_, identity, description) => {
      const body = added(0, "call-a") + doneWith(0, identity) + sse({ type: "response.completed" });
      const outcome = await turn(body, { custom: true });
      expect(outcome.log).toEqual([]);
      expect(outcome.history).toEqual([]);
      expect(squashed(outcome.exit)).toMatchObject({
        _tag: "AiError",
        reason: { _tag: "InvalidOutputError", description },
      });
    },
  );

  const contradicts = "Codex completed a response whose output contradicts its stream";
  const streamedGroup =
    added(0, "call-a") +
    doneWith(0, { id: "item-0", call_id: "call-a", name: "first" }) +
    message(1, { status: "completed" }) +
    reasoning(2, "completed") +
    added(3, "call-b", "second") +
    doneById(3);
  const listedMessage = {
    type: "message",
    id: "m1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "partial" }],
  };
  const listedReasoning = {
    type: "reasoning",
    id: "r2",
    summary: [{ type: "summary_text", text: "partial" }],
  };
  const listedB = listedCall({
    id: "item-3",
    call_id: "call-b",
    name: "second",
    arguments: JSON.stringify({ key: "b" }),
  });
  const listedGroup: Array<Json> = [listedMessage, listedReasoning, listedCall(), listedB];

  it.each([
    [
      "adds an undeclared Provider computer call",
      [
        ...listedGroup,
        {
          type: "computer_call",
          id: "cu2",
          call_id: "call-cu",
          status: "completed",
          action: { type: "screenshot" },
          pending_safety_checks: [],
        },
      ],
      "Codex returned an unrequested Provider Tool item (computer_call)",
    ],
    [
      "adds a function call that was never streamed",
      [...listedGroup, listedCall({ id: "item-9", call_id: "call-z" })],
      contradicts,
    ],
    ["omits a streamed call", listedGroup.slice(0, 3), contradicts],
    ["omits a streamed message", listedGroup.slice(1), contradicts],
    ["lists a streamed call twice", [...listedGroup, listedCall()], contradicts],
    [
      "lists the streamed call under another Tool name",
      [...listedGroup.slice(0, 2), listedCall({ name: "second" }), listedB],
      contradicts,
    ],
    [
      "lists the streamed call with other arguments",
      [
        ...listedGroup.slice(0, 2),
        listedCall({ arguments: JSON.stringify({ key: "z" }) }),
        listedB,
      ],
      contradicts,
    ],
    [
      "lists the streamed call with invalid JSON arguments",
      [...listedGroup.slice(0, 2), listedCall({ arguments: "{" }), listedB],
      "Invalid JSON arguments for Tool first",
    ],
    [
      "lists the streamed call with status in_progress",
      [...listedGroup.slice(0, 2), listedCall({ status: "in_progress" }), listedB],
      contradicts,
    ],
    [
      "lists the streamed call without its call id",
      [
        ...listedGroup.slice(0, 2),
        { type: "function_call", id: "item-0", name: "first", arguments: '{"key":"a"}' },
        listedB,
      ],
      contradicts,
    ],
    [
      "lists the message with status incomplete",
      [{ ...listedMessage, status: "incomplete" }, ...listedGroup.slice(1)],
      contradicts,
    ],
    [
      "lists the reasoning with status in_progress",
      [listedMessage, { ...listedReasoning, status: "in_progress" }, ...listedGroup.slice(2)],
      contradicts,
    ],
    ["is null", null, "Codex sent a malformed terminal event"],
    ["is not a list", { items: [] }, "Codex sent a malformed terminal event"],
  ])(
    "fails a completed response whose terminal output %s before any dispatch",
    async (_, output, description) => {
      const outcome = await turn(streamedGroup + completedWith(output), { custom: true });
      expect(outcome.log).toEqual([]);
      expect(outcome.history).toEqual([]);
      expect(squashed(outcome.exit)).toMatchObject({
        _tag: "AiError",
        reason: { _tag: "InvalidOutputError", description },
      });
      expect(outcome.usage).toEqual({ generations: 1, dispatches: 0, physicalRequests: 1 });
    },
  );

  it.each([
    ["absent", sse({ type: "response.completed" })],
    ["absent with a response", sse({ type: "response.completed", response: { id: "resp" } })],
    ["empty", completedWith([])],
    ["the streamed items in order", completedWith(listedGroup)],
    ["the streamed items reordered", completedWith([...listedGroup].reverse())],
    [
      "the streamed items with semantically equal call arguments",
      completedWith([
        ...listedGroup.slice(0, 2),
        listedCall({ arguments: '{ "key" : "a" }' }),
        listedB,
      ]),
    ],
  ])("dispatches a complete group whose terminal output is %s", async (_, terminal) => {
    const outcome = await turn(streamedGroup + terminal, { custom: true });
    expect(outcome.log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({ _tag: "Complete" });
  });

  it.each([
    ["an open message", message(1)],
    ["a message finished with status incomplete", message(1, { status: "incomplete" })],
    ["reasoning finished with status incomplete", reasoning(1, "incomplete")],
    [
      "reasoning started but never finished",
      sse({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "reasoning", id: "r1", summary: [], status: "in_progress" },
      }),
    ],
  ])("keeps an explicitly incomplete response with %s as incomplete data", async (_, extra) => {
    const body =
      added(0, "call-a") +
      doneAt(0) +
      extra +
      sse({
        type: "response.incomplete",
        response: {
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "message", id: "m1", status: "incomplete", content: [] }],
        },
      });
    const outcome = await turn(body, { custom: true });
    expect(outcome.log).toEqual([]);
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
      _tag: "Incomplete",
      reason: "length",
    });
  });

  const reasoningStart = sse({
    type: "response.output_item.added",
    output_index: 1,
    item: { type: "reasoning", id: "r1", summary: [], status: "in_progress" },
  });
  it.each([
    [
      "reasoning started but never finished",
      added(0, "call-a") + reasoningStart + doneAt(0),
      "Codex completed a response with unfinished output",
    ],
    [
      "reasoning without an item id started but never finished",
      added(0, "call-a") +
        sse({
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "reasoning", summary: [] },
        }) +
        doneAt(0),
      "Codex completed a response with unfinished output",
    ],
    [
      "a call started without its call id",
      sse({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "item-0", name: "first", arguments: "" },
      }) + doneAt(0),
      "Codex sent an incomplete Tool call",
    ],
    [
      "a call whose arguments are empty",
      added(0, "call-a") + doneWith(0, { arguments: "" }),
      "Invalid JSON arguments for Tool first",
    ],
    [
      "a call whose arguments were never supplied",
      added(0, "call-a") +
        sse({
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "function_call" },
        }),
      "Invalid JSON arguments for Tool first",
    ],
  ])(
    "fails a completed response with %s alongside a valid call before any dispatch",
    async (_, items, description) => {
      const body =
        items + added(2, "call-b", "second") + doneAt(2) + sse({ type: "response.completed" });
      const outcome = await turn(body, { custom: true });
      expect(outcome.log).toEqual([]);
      expect(outcome.history).toEqual([]);
      expect(squashed(outcome.exit)).toMatchObject({
        _tag: "AiError",
        reason: { _tag: "InvalidOutputError", description },
      });
    },
  );

  it.each([
    [
      "the start item",
      sse({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "item-0",
          call_id: "call-a",
          name: "first",
          arguments: '{"key":"a"}',
        },
      }),
    ],
    [
      "argument deltas",
      added(0, "call-a") +
        sse({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"key"' }) +
        sse({ type: "response.function_call_arguments.delta", output_index: 0, delta: ':"a"}' }),
    ],
  ])("dispatches a call whose arguments came only from %s", async (_, start) => {
    const body =
      start +
      sse({ type: "response.output_item.done", output_index: 0, item: { type: "function_call" } }) +
      sse({ type: "response.completed" });
    const outcome = await turn(body, { custom: true });
    expect(outcome.log).toEqual(["first:start", "first:end"]);
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({ _tag: "Complete" });
  });

  it("accepts reasoning started by output index and finished through its item id", async () => {
    const body =
      added(0, "call-a") +
      reasoningStart +
      doneAt(0) +
      sse({
        type: "response.output_item.done",
        item_id: "r1",
        item: { type: "reasoning", id: "r1", summary: [], status: "completed" },
      }) +
      sse({ type: "response.completed" });
    const outcome = await turn(body, { custom: true });
    expect(outcome.log).toEqual(["first:start", "first:end"]);
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({ _tag: "Complete" });
  });

  it("fails a no-parameter call with empty arguments instead of reading them as {}", async () => {
    const Ping = Tool.make("ping", { success: Schema.String });
    const PingKit = Toolkit.make(First, Ping);
    const log: Array<string> = [];
    const body =
      added(0, "call-a") +
      doneAt(0) +
      added(1, "call-p", "ping") +
      doneWith(1, { arguments: "" }) +
      sse({ type: "response.completed" });
    const server = await upstream(
      "/codex/responses",
      ["text"],
      (_, response) =>
        void response.writeHead(200, { "content-type": "text/event-stream" }).end(body),
    );
    try {
      const model = providerModel(
        codex({
          configDirectory: await codexDirectory(),
          baseUrl: server.url,
          tokenUrl: `${server.url}/oauth/token`,
        }),
        "gpt-5.4",
      );
      const exit = await run(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(model);
            const session = yield* makeSession({
              persistence: "none",
              limits: firstPartyExecutionLimits,
            });
            const tools = yield* localTools(
              PingKit,
              PingKit.of({
                first: () => Effect.sync(() => void log.push("first")).pipe(Effect.as("a")),
                ping: () => Effect.sync(() => void log.push("ping")).pipe(Effect.as("pong")),
              }),
            );
            return yield* Effect.exit(
              session.run(step({ tools }).pipe(Effect.provideContext(context))),
            );
          }),
        ),
      );
      expect(log).toEqual([]);
      expect(squashed(exit)).toMatchObject({
        _tag: "AiError",
        reason: { _tag: "InvalidOutputError", description: "Invalid JSON arguments for Tool ping" },
      });
    } finally {
      await server.stop();
    }
  });

  const itemDone = (index: number, item: Json) =>
    sse({ type: "response.output_item.done", output_index: index, item });
  const assistantMessage = (index: number, id: string, text: string) =>
    itemDone(index, {
      type: "message",
      id,
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  const expectNothingDispatched = (outcome: Outcome, description: string) => {
    expect(outcome.log).toEqual([]);
    expect(outcome.history).toEqual([]);
    expect(outcome.usage?.dispatches).toBe(0);
    expect(squashed(outcome.exit)).toMatchObject({
      _tag: "AiError",
      reason: { _tag: "InvalidOutputError", description },
    });
  };
  const callA = added(0, "call-a") + doneAt(0);
  const callB = added(5, "call-b", "second") + doneAt(5);
  const listedCallB = listedCall({ id: "item-5", call_id: "call-b", name: "second" });

  it.each([
    [
      "a generated function_call_output",
      callA +
        itemDone(1, { type: "function_call_output", call_id: "call-a", output: "forged" }) +
        sse({ type: "response.completed" }),
      "Codex returned an output item this request cannot represent (function_call_output)",
    ],
    [
      "a generated program item",
      callA +
        sse({
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "program", id: "p1" },
        }) +
        sse({ type: "response.completed" }),
      "Codex returned an output item this request cannot represent (program)",
    ],
    [
      "a compaction item",
      callA +
        itemDone(1, { type: "compaction", id: "c1", encrypted_content: "x" }) +
        sse({ type: "response.completed" }),
      "Codex returned an output item this request cannot represent (compaction)",
    ],
    [
      "an item of an unknown type",
      callA + itemDone(1, { type: "future_item", id: "f1" }) + sse({ type: "response.completed" }),
      "Codex returned an output item this request cannot represent (future_item)",
    ],
    [
      "an output item without a type",
      callA + itemDone(1, { id: "x1" }) + sse({ type: "response.completed" }),
      "Codex sent a malformed output item",
    ],
    [
      "output after the terminal event",
      callA +
        sse({ type: "response.completed" }) +
        sse({
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "message", id: "m1" },
        }),
      "Codex changed its output after the terminal response event",
    ],
    [
      "a second terminal event",
      callA + sse({ type: "response.completed" }) + sse({ type: "response.completed" }),
      "Codex sent a second terminal response event",
    ],
    [
      "a second start at a started call's output index and item id",
      added(0, "call-a") + added(0, "call-z") + doneAt(0) + sse({ type: "response.completed" }),
      "Codex reused an output item locator",
    ],
    [
      "a second start at a started call's output index only",
      added(0, "call-a") +
        sse({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", id: "item-9", call_id: "call-z", name: "first" },
        }) +
        doneAt(0) +
        sse({ type: "response.completed" }),
      "Codex reused an output item locator",
    ],
    [
      "a second start reusing a started call's item id at another index",
      added(0, "call-a") +
        sse({
          type: "response.output_item.added",
          output_index: 3,
          item: { type: "message", id: "item-0" },
        }) +
        doneAt(0) +
        sse({ type: "response.completed" }),
      "Codex reused an output item locator",
    ],
    [
      "a done item whose id names another item than its output index",
      callA +
        sse({ type: "response.output_item.added", output_index: 1, item: { type: "message" } }) +
        reasoning(2, "completed") +
        itemDone(1, { type: "message", id: "r2", content: [] }) +
        sse({ type: "response.completed" }),
      "Codex sent output events that contradict each other",
    ],
    [
      "one reasoning item finished twice",
      callA +
        reasoning(1, "completed") +
        reasoning(1, "completed") +
        sse({ type: "response.completed" }),
      "Codex finished an output item twice",
    ],
    [
      "final arguments whose item id names another item",
      added(0, "call-a") +
        sse({
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: "item-9",
          arguments: JSON.stringify({ key: "z" }),
        }) +
        doneAt(0) +
        sse({ type: "response.completed" }),
      "Codex sent output events that contradict each other",
    ],
    [
      "a message started as one item id and finished as another",
      callA +
        sse({
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "message", id: "m1" },
        }) +
        itemDone(1, { type: "message", id: "m9", content: [] }) +
        sse({ type: "response.completed" }),
      "Codex sent output events that contradict each other",
    ],
    [
      "an item id reused by a later item at another index",
      callA + assistantMessage(1, "item-0", "hi") + sse({ type: "response.completed" }),
      "Codex sent output events that contradict each other",
    ],
    [
      "done content that contradicts the streamed text",
      callA +
        message(1, { content: [{ type: "output_text", text: "other" }] }) +
        sse({ type: "response.completed" }),
      "Codex finished a message whose content contradicts its stream",
    ],
    [
      "terminal output listing the call under another item id",
      callA +
        completedWith([
          {
            type: "function_call",
            id: "item-7",
            call_id: "call-a",
            name: "first",
            arguments: JSON.stringify({ key: "a" }),
          },
          listedCallB,
        ]),
      "Codex completed a response whose output contradicts its stream",
    ],
    [
      "terminal output listing a message with other text",
      callA +
        assistantMessage(1, "m1", "hello") +
        completedWith([
          listedCall(),
          listedCallB,
          {
            type: "message",
            id: "m1",
            role: "assistant",
            content: [{ type: "output_text", text: "bye" }],
          },
        ]),
      "Codex completed a response whose output contradicts its stream",
    ],
    [
      "terminal output listing reasoning with another summary",
      callA +
        reasoning(1, "completed") +
        completedWith([
          listedCall(),
          listedCallB,
          { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "other" }] },
        ]),
      "Codex completed a response whose output contradicts its stream",
    ],
    [
      "an item status outside the Responses statuses",
      callA +
        itemDone(1, { type: "reasoning", id: "r1", status: "failed", summary: [] }) +
        sse({
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" } },
        }),
      "Codex sent a malformed output item",
    ],
    [
      "a null item status",
      callA +
        itemDone(1, { type: "message", id: "m1", status: null, content: [] }) +
        sse({ type: "response.completed" }),
      "Codex sent a malformed output item",
    ],
  ])("pass12: fails a mixed group with %s before any dispatch", async (_, body, description) => {
    const outcome = await turn(callB + body, { custom: true });
    expectNothingDispatched(outcome, description);
  });

  it.each([
    ["failed", { message: "boom" }, "boom"],
    ["cancelled", null, "Codex response was cancelled by the provider"],
  ])(
    "pass12: fails a response.incomplete whose explicit status is %s",
    async (status, error, description) => {
      const outcome = await turn(
        callA +
          sse({
            type: "response.incomplete",
            response: {
              status,
              error,
              incomplete_details: { reason: "max_output_tokens" },
            },
          }),
        { custom: true },
      );
      expect(outcome.log).toEqual([]);
      expect(squashed(outcome.exit)).toMatchObject({
        _tag: "AiError",
        reason: { _tag: "UnknownError", description },
      });
    },
  );

  it("pass12: projects a message that arrives whole in its done event, as the Codex CLI fixture does", async () => {
    const outcome = await turn(
      assistantMessage(0, "msg-1", "Hello from done") + sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({ _tag: "Complete" });
    expect(JSON.stringify(outcome.history)).toContain("Hello from done");
  });

  it("pass12: keeps streamed text once when the done content repeats it", async () => {
    const outcome = await turn(
      message(0, { content: [{ type: "output_text", text: "partial" }] }) +
        completedWith([
          {
            type: "message",
            id: "m0",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "partial" }],
          },
        ]),
      { custom: true },
    );
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({ _tag: "Complete" });
    const history = JSON.stringify(outcome.history);
    expect(history).toContain("partial");
    expect(history).not.toContain("partialpartial");
  });

  it("pass12: dispatches a mixed group with done-only message and reasoning alongside calls", async () => {
    const outcome = await turn(
      callA +
        assistantMessage(1, "m1", "note") +
        reasoning(2, "completed") +
        callB +
        sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(outcome.log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({ _tag: "Complete" });
  });

  it("pass12: adopts the item id a done event gives an item started without one", async () => {
    const outcome = await turn(
      callA +
        sse({ type: "response.output_item.added", output_index: 1, item: { type: "message" } }) +
        sse({ type: "response.output_text.delta", output_index: 1, delta: "hi" }) +
        itemDone(1, { type: "message", id: "m1" }) +
        completedWith([
          listedCall(),
          {
            type: "message",
            id: "m1",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
        ]),
      { custom: true },
    );
    expect(outcome.log).toEqual(["first:start", "first:end"]);
    expect(Exit.isSuccess(outcome.exit)).toBe(true);
  });

  it("pass12: ignores unknown non-output telemetry, including after the terminal event", async () => {
    const outcome = await turn(
      callA +
        sse({ type: "codex.response.metadata", data: {} }) +
        sse({ type: "response.completed" }) +
        sse({ type: "responsesapi.websocket_timing", ms: 1 }),
      { custom: true },
    );
    expect(outcome.log).toEqual(["first:start", "first:end"]);
    expect(Exit.isSuccess(outcome.exit)).toBe(true);
  });

  const refusalMessage = (index: number, id: string, content: ReadonlyArray<Json>) =>
    itemDone(index, { type: "message", id, role: "assistant", content: [...content] });
  const refusal = { type: "refusal", refusal: "I can't help with that" };
  const ResponseText = Schema.Struct({
    _tag: Schema.Literals(["Complete", "Incomplete"]),
    response: Schema.Struct({
      content: Schema.Array(
        Schema.Struct({
          type: Schema.String,
          text: Schema.optional(Schema.String),
          metadata: Schema.optional(
            Schema.Struct({
              openai: Schema.optional(Schema.Struct({ refusal: Schema.optional(Schema.String) })),
            }),
          ),
        }),
      ),
    }),
  });
  type ShownPart =
    | { readonly text: string | undefined; readonly refusal: string | undefined }
    | { readonly reasoning: string | undefined };
  /** The text parts of a complete Step's native response, with any refusal explanation. */
  const textParts = (outcome: Outcome, tag: "Complete" | "Incomplete" = "Complete") => {
    if (!Exit.isSuccess(outcome.exit)) throw new Error(`expected a ${tag} Step`);
    const { _tag, response } = Schema.decodeUnknownSync(ResponseText)(outcome.exit.value);
    if (_tag !== tag) throw new Error(`expected a ${tag} Step, got ${_tag}`);
    return response.content.flatMap((part): Array<ShownPart> => {
      if (part.type === "text")
        return [{ text: part.text, refusal: part.metadata?.openai?.refusal }];
      if (part.type === "reasoning") return [{ reasoning: part.text }];
      return [];
    });
  };

  it("pass13: keeps a refusal as an empty text part with its native refusal metadata", async () => {
    const outcome = await turn(
      callA + refusalMessage(1, "m1", [refusal]) + sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(outcome.log).toEqual(["first:start", "first:end"]);
    expect(textParts(outcome)).toEqual([{ text: "", refusal: "I can't help with that" }]);
    // History keeps the refusal as metadata of an empty text part, never as ordinary text.
    const assistant = outcome.history.find((message) => message.role === "assistant");
    expect(JSON.stringify(assistant)).toContain('"refusal":"I can\'t help with that"');
    expect(JSON.stringify(assistant)).not.toContain('"text":"I can\'t help with that"');
  });

  it("pass13: keeps streamed text once beside a refusal from the done content", async () => {
    const outcome = await turn(
      message(0, { content: [{ type: "output_text", text: "partial" }, refusal] }) +
        sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(textParts(outcome)).toEqual([
      { text: "partial", refusal: undefined },
      { text: "", refusal: "I can't help with that" },
    ]);
  });

  const text = (value: string) => ({ type: "output_text", text: value });
  const refusalR = { type: "refusal", refusal: "R" };
  const started = (index: number, id: string) =>
    sse({ type: "response.output_item.added", output_index: index, item: { type: "message", id } });

  it.each([
    [
      "refusal first",
      [refusalR, text("T")],
      [
        { text: "", refusal: "R" },
        { text: "T", refusal: undefined },
      ],
    ],
    [
      "text, refusal, text",
      [text("A"), refusalR, text("B")],
      [
        { text: "A", refusal: undefined },
        { text: "", refusal: "R" },
        { text: "B", refusal: undefined },
      ],
    ],
    ["an empty content list", [], []],
  ])("pass16: keeps a done-only message's %s content in order", async (_, content, parts) => {
    const outcome = await turn(
      refusalMessage(0, "m0", content) + sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(textParts(outcome)).toEqual(parts);
  });

  it("pass16: keeps a started refusal-only message as the refusal part alone", async () => {
    const outcome = await turn(
      started(0, "m0") + refusalMessage(0, "m0", [refusalR]) + sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(textParts(outcome)).toEqual([{ text: "", refusal: "R" }]);
  });

  it.each([
    [
      "refusal first",
      [refusalR, text("T")],
      [
        { text: "", refusal: "R" },
        { text: "T", refusal: undefined },
      ],
    ],
    [
      "refusal last",
      [text("T"), refusalR],
      [
        { text: "T", refusal: undefined },
        { text: "", refusal: "R" },
      ],
    ],
  ])(
    "pass16: keeps streamed text once, ordered around a %s done refusal",
    async (_, content, parts) => {
      const outcome = await turn(
        started(0, "m0") +
          sse({ type: "response.output_text.delta", output_index: 0, delta: "T" }) +
          refusalMessage(0, "m0", content) +
          sse({ type: "response.completed" }),
        { custom: true },
      );
      expect(textParts(outcome)).toEqual(parts);
    },
  );

  it("pass16: dispatches a group whose terminal lists the message's content in the same order", async () => {
    const outcome = await turn(
      callA +
        refusalMessage(1, "m1", [refusalR, text("T")]) +
        completedWith([
          listedCall(),
          { type: "message", id: "m1", role: "assistant", content: [refusalR, text("T")] },
        ]),
      { custom: true },
    );
    expect(outcome.log).toEqual(["first:start", "first:end"]);
    expect(Exit.isSuccess(outcome.exit)).toBe(true);
  });

  it.each([
    [
      "a terminal list reordering the message's refusal and text",
      callA +
        refusalMessage(1, "m1", [refusalR, text("T")]) +
        completedWith([
          listedCall(),
          listedCallB,
          { type: "message", id: "m1", role: "assistant", content: [text("T"), refusalR] },
        ]),
      "Codex completed a response whose output contradicts its stream",
    ],
    [
      "streamed text split around a done refusal",
      started(1, "m1") +
        sse({ type: "response.output_text.delta", output_index: 1, delta: "AB" }) +
        refusalMessage(1, "m1", [text("A"), refusalR, text("B")]) +
        sse({ type: "response.completed" }),
      "Codex returned message content this request cannot represent (streamed text around a refusal)",
    ],
  ])("pass16: fails a mixed group with %s before any dispatch", async (_, body, description) => {
    const outcome = await turn(callB + body, { custom: true });
    expectNothingDispatched(outcome, description);
  });

  it("pass13: keeps a done-only message's text and refusal in order", async () => {
    const outcome = await turn(
      refusalMessage(0, "m0", [{ type: "output_text", text: "Sorry." }, refusal]) +
        sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(textParts(outcome)).toEqual([
      { text: "Sorry.", refusal: undefined },
      { text: "", refusal: "I can't help with that" },
    ]);
  });

  it.each([
    [
      "message content of an unrepresentable type",
      callA +
        refusalMessage(1, "m1", [{ type: "output_audio", data: "x" }]) +
        sse({ type: "response.completed" }),
      "Codex returned message content this request cannot represent (output_audio)",
    ],
    [
      "a refusal part without its explanation",
      callA + refusalMessage(1, "m1", [{ type: "refusal" }]) + sse({ type: "response.completed" }),
      "Codex sent a malformed message",
    ],
    [
      "terminal output listing a message with another refusal",
      callA +
        refusalMessage(1, "m1", [refusal]) +
        completedWith([
          listedCall(),
          listedCallB,
          {
            type: "message",
            id: "m1",
            role: "assistant",
            content: [{ type: "refusal", refusal: "other" }],
          },
        ]),
      "Codex completed a response whose output contradicts its stream",
    ],
  ])("pass13: fails a mixed group with %s before any dispatch", async (_, body, description) => {
    const outcome = await turn(callB + body, { custom: true });
    expectNothingDispatched(outcome, description);
  });

  it("pass13: dispatches a group whose terminal output lists the same refusal", async () => {
    const outcome = await turn(
      callA +
        refusalMessage(1, "m1", [refusal]) +
        completedWith([
          listedCall(),
          { type: "message", id: "m1", role: "assistant", content: [refusal] },
        ]),
      { custom: true },
    );
    expect(outcome.log).toEqual(["first:start", "first:end"]);
    expect(Exit.isSuccess(outcome.exit)).toBe(true);
  });

  it("pass13: keeps an explicitly incomplete response with a refusal as incomplete data", async () => {
    const outcome = await turn(
      callA +
        refusalMessage(1, "m1", [refusal]) +
        sse({
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" } },
        }),
      { custom: true },
    );
    expect(outcome.log).toEqual([]);
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
      _tag: "Incomplete",
      reason: "length",
    });
  });

  /**
   * Two Turns on one Session and one Codex binding: the first answers `first`, the second
   * `second`. Returns each Turn's exit, the committed history after each, the upstream requests
   * and the handler log.
   */
  const twoTurns = async (first: string, second: string) => {
    const bodies = [first, second];
    const server = await upstream(
      "/codex/responses",
      ["text", "text"],
      (_, response) =>
        void response
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(bodies.shift() ?? sse({ type: "response.completed" })),
    );
    try {
      const model = providerModel(
        codex({
          configDirectory: await codexDirectory(),
          baseUrl: server.url,
          tokenUrl: `${server.url}/oauth/token`,
        }),
        "gpt-5.4",
      );
      const log: Array<string> = [];
      const result = await run(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(model);
            const session = yield* makeSession({
              persistence: "none",
              limits: firstPartyExecutionLimits,
            });
            const tools = yield* localTools(
              Kit,
              Kit.of({
                first: () => Effect.sync(() => (log.push("first"), "a")),
                second: () => Effect.sync(() => (log.push("second"), "b")),
              }),
            );
            const turn = (text: string) =>
              Effect.exit(
                session.run(
                  Effect.gen(function* () {
                    const current = yield* Turn;
                    yield* current.stage(
                      Prompt.userMessage({ content: [Prompt.textPart({ text })] }),
                    );
                    return yield* step({ tools });
                  }).pipe(Effect.provideContext(context)),
                ),
              );
            const firstExit = yield* turn("one");
            const afterFirst = yield* session.history;
            const secondExit = yield* turn("two");
            const afterSecond = yield* session.history;
            return { firstExit, afterFirst, secondExit, afterSecond };
          }),
        ),
      );
      return { ...result, requests: server.requests, log };
    } finally {
      await server.stop();
    }
  };
  const refusalDescription =
    "Codex cannot send a conversation that contains a refusal: the Codex request has no refusal input form";

  it.each([
    ["refusal only", [refusal]],
    ["text and refusal", [{ type: "output_text", text: "Sorry." }, refusal]],
  ])(
    "pass14: rejects the next Codex request of a history with a %s before sending it",
    async (_, content) => {
      const outcome = await twoTurns(
        refusalMessage(0, "m0", content) + sse({ type: "response.completed" }),
        sse({ type: "response.completed" }),
      );
      // The refusal response itself is kept: complete, committed and inspectable.
      expect(Exit.isSuccess(outcome.firstExit)).toBe(true);
      expect(JSON.stringify(outcome.afterFirst)).toContain('"refusal":"I can\'t help with that"');
      // The next request is refused natively before any send: one request in total, no retry.
      expect(squashed(outcome.secondExit)).toMatchObject({
        _tag: "AiError",
        reason: { _tag: "InvalidOutputError", description: refusalDescription },
      });
      expect(outcome.requests.length).toBe(1);
      expect(outcome.log).toEqual([]);
      expect(outcome.afterSecond).toEqual(outcome.afterFirst);
    },
  );

  it("pass14: sends the next Codex request of a history without a refusal", async () => {
    const outcome = await twoTurns(
      assistantMessage(0, "m0", "Hello") + sse({ type: "response.completed" }),
      sse({ type: "response.completed" }),
    );
    expect(Exit.isSuccess(outcome.firstExit)).toBe(true);
    expect(Exit.isSuccess(outcome.secondExit)).toBe(true);
    expect(outcome.requests.length).toBe(2);
    expect(JSON.stringify(outcome.requests[1]?.body["input"])).toContain("Hello");
  });

  const sparseCall = (callId: string, name: string, args: Json) =>
    sse({
      type: "response.output_item.done",
      item: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) },
    });

  it("pass14: accepts the Codex CLI's id-only message start with a locator-less text delta", async () => {
    const outcome = await turn(
      callB +
        sse({
          type: "response.output_item.added",
          item: { type: "message", role: "assistant", id: "msg-1", content: [] },
        }) +
        sse({ type: "response.output_text.delta", delta: "hello" }) +
        sse({
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: "msg-1",
            content: [{ type: "output_text", text: "hello" }],
          },
        }) +
        sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(outcome.log).toEqual(["second:start", "second:end"]);
    expect(JSON.stringify(outcome.history)).toContain('"text":"hello"');
    expect(JSON.stringify(outcome.history)).not.toContain("hellohello");
  });

  it("pass14: dispatches the Codex CLI's fully specified done-only call", async () => {
    const outcome = await turn(
      callB + sparseCall("call-d", "first", { key: "d" }) + sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(outcome.log).toEqual(["second:start", "second:end", "first:start", "first:end"]);
    expect(Exit.isSuccess(outcome.exit)).toBe(true);
  });

  it("pass14: keeps an index-keyed and an id-keyed message apart when the id equals the index", async () => {
    const outcome = await turn(
      callB +
        sse({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "m-a" },
        }) +
        sse({ type: "response.output_text.delta", output_index: 0, delta: "A" }) +
        sse({
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: "0",
            content: [{ type: "output_text", text: "B" }],
          },
        }) +
        itemDone(0, { type: "message", id: "m-a", content: [{ type: "output_text", text: "A" }] }) +
        sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(Exit.isSuccess(outcome.exit)).toBe(true);
    const history = JSON.stringify(outcome.history);
    expect(history).toContain('"text":"A"');
    expect(history).toContain('"text":"B"');
  });

  it("pass14: accepts repeated identical final arguments and a matching text-done event", async () => {
    const outcome = await turn(
      added(0, "call-a") +
        sse({
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: JSON.stringify({ key: "a" }),
        }) +
        sse({
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: JSON.stringify({ key: "a" }),
        }) +
        sse({
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "function_call" },
        }) +
        sse({
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "message", id: "m1" },
        }) +
        sse({
          type: "response.content_part.added",
          output_index: 1,
          item_id: "m1",
          content_index: 0,
          part: { type: "output_text", text: "" },
        }) +
        sse({ type: "response.output_text.delta", output_index: 1, item_id: "m1", delta: "hi" }) +
        sse({ type: "response.output_text.done", output_index: 1, item_id: "m1", text: "hi" }) +
        itemDone(1, { type: "message", id: "m1", content: [{ type: "output_text", text: "hi" }] }) +
        sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(outcome.log).toEqual(["first:start", "first:end"]);
    expect(Exit.isSuccess(outcome.exit)).toBe(true);
  });

  it("pass14: keeps an explicitly incomplete response whose terminal lists representable incomplete items", async () => {
    const outcome = await turn(
      callA +
        sse({
          type: "response.incomplete",
          response: {
            incomplete_details: { reason: "max_output_tokens" },
            output: [{ type: "message", id: "m9", status: "incomplete", content: [] }],
          },
        }),
      { custom: true },
    );
    expect(outcome.log).toEqual([]);
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
      _tag: "Incomplete",
    });
  });

  it.each([
    [
      "a locator-less text delta while two messages are open",
      sse({ type: "response.output_item.added", item: { type: "message", id: "m1" } }) +
        sse({ type: "response.output_item.added", item: { type: "message", id: "m2" } }) +
        sse({ type: "response.output_text.delta", delta: "x" }) +
        sse({ type: "response.completed" }),
      "Codex sent an output event that names no single item",
    ],
    [
      "a done-only call without its arguments",
      sse({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call-d", name: "first" },
      }) + sse({ type: "response.completed" }),
      "Codex completed an unknown Tool call",
    ],
    [
      "a done-only call reusing another call's call id",
      sparseCall("call-b", "first", { key: "d" }) + sse({ type: "response.completed" }),
      "Codex reused a Tool call id",
    ],
    [
      "terminal output giving an unknown call item id that another item has",
      assistantMessage(1, "m", "hi") +
        sparseCall("call-d", "first", { key: "d" }) +
        completedWith([
          listedCallB,
          {
            type: "message",
            id: "m",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
          {
            type: "function_call",
            id: "m",
            call_id: "call-d",
            name: "first",
            arguments: JSON.stringify({ key: "d" }),
          },
        ]),
      "Codex completed a response whose output contradicts its stream",
    ],
    [
      "terminal output giving a streamed call without an item id another item's id",
      sse({
        type: "response.output_item.added",
        output_index: 3,
        item: { type: "function_call", call_id: "call-c", name: "first" },
      }) +
        sse({
          type: "response.output_item.done",
          output_index: 3,
          item: { type: "function_call", arguments: JSON.stringify({ key: "c" }) },
        }) +
        assistantMessage(1, "m", "hi") +
        completedWith([
          listedCallB,
          {
            type: "message",
            id: "m",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
          {
            type: "function_call",
            id: "m",
            call_id: "call-c",
            name: "first",
            arguments: JSON.stringify({ key: "c" }),
          },
        ]),
      "Codex completed a response whose output contradicts its stream",
    ],
    [
      "terminal output listing one item id twice",
      assistantMessage(1, "m", "hi") +
        completedWith([
          { ...listedCallB, id: "m" },
          {
            type: "message",
            id: "m",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
        ]),
      "Codex completed a response whose output contradicts its stream",
    ],
    [
      "an incomplete terminal listing an item with an invalid status",
      sse({
        type: "response.incomplete",
        response: {
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "message", id: "m9", status: "failed", content: [] }],
        },
      }),
      "Codex sent a malformed output item",
    ],
    [
      "argument deltas after the final arguments",
      added(0, "call-a") +
        sse({
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: JSON.stringify({ key: "a" }),
        }) +
        sse({ type: "response.function_call_arguments.delta", output_index: 0, delta: "x" }) +
        doneAt(0) +
        sse({ type: "response.completed" }),
      "Codex sent output events that contradict each other",
    ],
    [
      "a content part added after the terminal event",
      sse({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "m1" },
      }) +
        itemDone(1, { type: "message", id: "m1", content: [] }) +
        sse({ type: "response.completed" }) +
        sse({
          type: "response.content_part.added",
          output_index: 1,
          item_id: "m1",
          content_index: 0,
          part: { type: "output_text", text: "" },
        }),
      "Codex changed its output after the terminal response event",
    ],
    [
      "a content part of an unrepresentable type",
      sse({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "m1" },
      }) +
        sse({
          type: "response.content_part.added",
          output_index: 1,
          item_id: "m1",
          content_index: 0,
          part: { type: "output_audio" },
        }) +
        itemDone(1, { type: "message", id: "m1", content: [] }) +
        sse({ type: "response.completed" }),
      "Codex returned message content this request cannot represent (output_audio)",
    ],
    [
      "a text-done event contradicting the streamed text",
      sse({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "m1" },
      }) +
        sse({ type: "response.output_text.delta", output_index: 1, delta: "hi" }) +
        sse({ type: "response.output_text.done", output_index: 1, text: "bye" }) +
        itemDone(1, { type: "message", id: "m1", content: [{ type: "output_text", text: "hi" }] }) +
        sse({ type: "response.completed" }),
      "Codex finished a message whose content contradicts its stream",
    ],
    [
      "a text-done event for no open message",
      sse({ type: "response.output_text.done", output_index: 7, text: "x" }) +
        sse({ type: "response.completed" }),
      "Codex sent text without a message item",
    ],
    [
      "contradictory repeated final arguments",
      added(0, "call-a") +
        sse({
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: JSON.stringify({ key: "a" }),
        }) +
        sse({
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: JSON.stringify({ key: "z" }),
        }) +
        sse({
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "function_call" },
        }) +
        sse({ type: "response.completed" }),
      "Codex sent output events that contradict each other",
    ],
    [
      "a start with an invalid item status",
      sse({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "item-0",
          call_id: "call-a",
          name: "first",
          status: "failed",
        },
      }) +
        doneAt(0) +
        sse({ type: "response.completed" }),
      "Codex sent a malformed output item",
    ],
    [
      "an incomplete terminal listing a program item",
      callA +
        sse({
          type: "response.incomplete",
          response: {
            incomplete_details: { reason: "max_output_tokens" },
            output: [{ type: "program" }],
          },
        }),
      "Codex returned an output item this request cannot represent (program)",
    ],
  ])("pass14: fails a mixed group with %s before any dispatch", async (_, body, description) => {
    const outcome = await turn(callB + body, { custom: true });
    expectNothingDispatched(outcome, description);
    expect(outcome.usage?.physicalRequests).toBe(1);
  });

  const ev = (type: string, fields: Record<string, Json>) => sse({ type, ...fields });
  const at = (index: number, id: string) => ({ output_index: index, item_id: id });
  const reasoningStarted = (index: number, id: string) =>
    ev("response.output_item.added", {
      output_index: index,
      item: { type: "reasoning", id, summary: [] },
    });
  const reasoningDone = (index: number, id: string, summary: ReadonlyArray<string>) =>
    itemDone(index, {
      type: "reasoning",
      id,
      summary: summary.map((value) => ({ type: "summary_text", text: value })),
    });
  const callWithoutId = (index: number, callId: string) =>
    ev("response.output_item.added", {
      output_index: index,
      item: { type: "function_call", call_id: callId, name: "first" },
    }) + itemDone(index, { type: "function_call", arguments: JSON.stringify({ key: "c" }) });
  const argsCall = (deltas: ReadonlyArray<string>, final: string) =>
    added(0, "call-a") +
    deltas
      .map((delta) => ev("response.function_call_arguments.delta", { output_index: 0, delta }))
      .join("") +
    ev("response.function_call_arguments.done", { output_index: 0, arguments: final }) +
    itemDone(0, { type: "function_call" });

  it.each([
    [
      "terminal output giving a call the item id another listed item owns",
      callWithoutId(3, "call-c") +
        completedWith([
          {
            type: "function_call",
            id: "item-5",
            call_id: "call-c",
            name: "first",
            arguments: JSON.stringify({ key: "c" }),
          },
          {
            type: "function_call",
            call_id: "call-b",
            name: "second",
            arguments: JSON.stringify({ key: "a" }),
          },
        ]),
      "Codex completed a response whose output contradicts its stream",
    ],
    [
      "a reasoning summary done event contradicting the finished reasoning",
      reasoningStarted(1, "r1") +
        ev("response.reasoning_summary_text.done", {
          ...at(1, "r1"),
          summary_index: 0,
          text: "X",
        }) +
        reasoningDone(1, "r1", ["Y"]) +
        sse({ type: "response.completed" }),
      "Codex sent output events that contradict each other",
    ],
    [
      "a streamed refusal part that the finished message omits",
      started(1, "m1") +
        ev("response.content_part.done", {
          ...at(1, "m1"),
          content_index: 0,
          part: { type: "refusal", refusal: "R" },
        }) +
        itemDone(1, { type: "message", id: "m1", content: [] }) +
        sse({ type: "response.completed" }),
      "Codex finished a message whose content contradicts its stream",
    ],
    [
      "an indexed text part finished with other text",
      started(1, "m1") +
        ev("response.output_text.delta", { ...at(1, "m1"), content_index: 1, delta: "B" }) +
        ev("response.output_text.done", { ...at(1, "m1"), content_index: 1, text: "C" }) +
        itemDone(1, { type: "message", id: "m1", content: [text("A"), text("C")] }) +
        sse({ type: "response.completed" }),
      "Codex finished a message whose content contradicts its stream",
    ],
    [
      "an indexed text delta after its part finished",
      started(1, "m1") +
        ev("response.output_text.done", { ...at(1, "m1"), content_index: 0, text: "A" }) +
        ev("response.output_text.delta", { ...at(1, "m1"), content_index: 0, delta: "B" }) +
        itemDone(1, { type: "message", id: "m1", content: [text("AB")] }) +
        sse({ type: "response.completed" }),
      "Codex sent output events that contradict each other",
    ],
    [
      "a finished message whose content moves a streamed refusal",
      started(1, "m1") +
        ev("response.output_text.delta", { ...at(1, "m1"), content_index: 0, delta: "A" }) +
        ev("response.refusal.done", { ...at(1, "m1"), content_index: 1, refusal: "R" }) +
        itemDone(1, { type: "message", id: "m1", content: [refusalR, text("A")] }) +
        sse({ type: "response.completed" }),
      "Codex finished a message whose content contradicts its stream",
    ],
    [
      "finished content with other text than an indexed streamed part",
      started(1, "m1") +
        ev("response.output_text.delta", { ...at(1, "m1"), content_index: 0, delta: "A" }) +
        itemDone(1, { type: "message", id: "m1", content: [text("Z")] }) +
        sse({ type: "response.completed" }),
      "Codex finished a message whose content contradicts its stream",
    ],
    [
      "a message start with unrepresentable nested content",
      ev("response.output_item.added", {
        output_index: 1,
        item: { type: "message", id: "m1", content: [{ type: "output_audio" }] },
      }) +
        itemDone(1, { type: "message", id: "m1", content: [] }) +
        sse({ type: "response.completed" }),
      "Codex returned message content this request cannot represent (output_audio)",
    ],
    [
      "an incomplete terminal listing a message with unrepresentable content",
      ev("response.incomplete", {
        response: {
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              type: "message",
              id: "m9",
              status: "incomplete",
              content: [{ type: "output_audio" }],
            },
          ],
        },
      }),
      "Codex returned message content this request cannot represent (output_audio)",
    ],
    [
      "first final arguments contradicting complete streamed arguments",
      argsCall([JSON.stringify({ key: "a" })], JSON.stringify({ key: "b" })) +
        sse({ type: "response.completed" }),
      "Codex sent output events that contradict each other",
    ],
    [
      "first final arguments contradicting partial streamed arguments",
      argsCall(['{"key":"a'], JSON.stringify({ key: "b" })) + sse({ type: "response.completed" }),
      "Codex sent output events that contradict each other",
    ],
    [
      "a refusal delta for no open message",
      ev("response.refusal.delta", { delta: "no" }) + sse({ type: "response.completed" }),
      "Codex sent a refusal without a message item",
    ],
  ])("pass17: fails a mixed group with %s before any dispatch", async (_, body, description) => {
    const outcome = await turn(callB + body, { custom: true });
    expectNothingDispatched(outcome, description);
    expect(outcome.usage?.physicalRequests).toBe(1);
  });

  it("pass17: keeps two indexed text parts of one message in order", async () => {
    const outcome = await turn(
      started(0, "m0") +
        ev("response.output_text.delta", { ...at(0, "m0"), content_index: 0, delta: "A" }) +
        ev("response.output_text.done", { ...at(0, "m0"), content_index: 0, text: "A" }) +
        ev("response.output_text.delta", { ...at(0, "m0"), content_index: 1, delta: "B" }) +
        ev("response.output_text.done", { ...at(0, "m0"), content_index: 1, text: "B" }) +
        itemDone(0, { type: "message", id: "m0", content: [text("A"), text("B")] }) +
        completedWith([
          { type: "message", id: "m0", role: "assistant", content: [text("A"), text("B")] },
        ]),
      { custom: true },
    );
    expect(textParts(outcome)).toEqual([
      { text: "A", refusal: undefined },
      { text: "B", refusal: undefined },
    ]);
  });

  it("pass17: keeps an indexed streamed refusal between streamed text parts", async () => {
    const outcome = await turn(
      started(0, "m0") +
        ev("response.output_text.delta", { ...at(0, "m0"), content_index: 0, delta: "A" }) +
        ev("response.content_part.added", {
          ...at(0, "m0"),
          content_index: 1,
          part: { type: "refusal", refusal: "" },
        }) +
        ev("response.refusal.delta", { ...at(0, "m0"), content_index: 1, delta: "R" }) +
        ev("response.refusal.done", { ...at(0, "m0"), content_index: 1, refusal: "R" }) +
        ev("response.output_text.delta", { ...at(0, "m0"), content_index: 2, delta: "B" }) +
        itemDone(0, { type: "message", id: "m0", content: [text("A"), refusalR, text("B")] }) +
        sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(textParts(outcome)).toEqual([
      { text: "A", refusal: undefined },
      { text: "", refusal: "R" },
      { text: "B", refusal: undefined },
    ]);
  });

  it("pass17: takes a sparse finished message's content from its indexed stream", async () => {
    const outcome = await turn(
      started(0, "m0") +
        ev("response.output_text.delta", { ...at(0, "m0"), content_index: 0, delta: "A" }) +
        ev("response.refusal.done", { ...at(0, "m0"), content_index: 1, refusal: "R" }) +
        itemDone(0, { type: "message", id: "m0" }) +
        sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(textParts(outcome)).toEqual([
      { text: "A", refusal: undefined },
      { text: "", refusal: "R" },
    ]);
  });

  it.each([
    [
      "indexed summary events",
      reasoningStarted(1, "r1") +
        ev("response.reasoning_summary_part.added", {
          ...at(1, "r1"),
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        }) +
        ev("response.reasoning_summary_text.delta", {
          ...at(1, "r1"),
          summary_index: 0,
          delta: "S",
        }) +
        ev("response.reasoning_summary_text.done", {
          ...at(1, "r1"),
          summary_index: 0,
          text: "S",
        }) +
        ev("response.reasoning_summary_part.done", {
          ...at(1, "r1"),
          summary_index: 0,
          part: { type: "summary_text", text: "S" },
        }) +
        reasoningDone(1, "r1", ["S"]),
    ],
    [
      "the Codex CLI's locator-less summary delta",
      ev("response.output_item.added", { item: { type: "reasoning", id: "r1", summary: [] } }) +
        ev("response.reasoning_summary_text.delta", { delta: "S", summary_index: 0 }) +
        ev("response.output_item.done", {
          item: { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "S" }] },
        }),
    ],
    [
      "final arguments completing a streamed prefix",
      argsCall(['{"key":'], JSON.stringify({ key: "a" })).replaceAll('"call-a"', '"call-p"'),
    ],
    [
      "final arguments semantically equal to the streamed ones",
      argsCall([JSON.stringify({ key: "a" })], '{ "key" : "a" }').replaceAll(
        '"call-a"',
        '"call-p"',
      ),
    ],
  ])("pass17: dispatches a group with %s", async (_, body) => {
    const outcome = await turn(callB + body + sse({ type: "response.completed" }), {
      custom: true,
    });
    expect(outcome.log.filter((entry) => entry.endsWith(":start")).length).toBe(
      body.includes("call-p") ? 2 : 1,
    );
    expect(Exit.isSuccess(outcome.exit)).toBe(true);
  });

  it("pass17: keeps an incomplete terminal with valid nested message content inspectable", async () => {
    const outcome = await turn(
      callA +
        ev("response.incomplete", {
          response: {
            incomplete_details: { reason: "max_output_tokens" },
            output: [
              { type: "message", id: "m9", status: "incomplete", content: [text("x"), refusalR] },
            ],
          },
        }),
      { custom: true },
    );
    expect(outcome.log).toEqual([]);
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
      _tag: "Incomplete",
    });
    // The terminal-only partial message stays inspectable, in content order.
    expect(textParts(outcome, "Incomplete")).toEqual([
      { text: "x", refusal: undefined },
      { text: "", refusal: "R" },
    ]);
  });

  const reasoningWith = (index: number, id: string, summary: string, content: string) =>
    itemDone(index, {
      type: "reasoning",
      id,
      summary: [{ type: "summary_text", text: summary }],
      content: [{ type: "reasoning_text", text: content }],
    });
  const itemDoneArgs = (index: number, args: string) =>
    itemDone(index, { type: "function_call", arguments: args });
  const deltaArgs = (index: number, delta: string) =>
    ev("response.function_call_arguments.delta", { output_index: index, delta });
  const incomplete = (output: ReadonlyArray<Json> = []) =>
    ev("response.incomplete", {
      response: { incomplete_details: { reason: "max_output_tokens" }, output: [...output] },
    });

  it.each([
    [
      "finished call arguments contradicting complete streamed arguments",
      added(0, "call-a") +
        deltaArgs(0, JSON.stringify({ key: "a" })) +
        itemDoneArgs(0, JSON.stringify({ key: "b" })) +
        sse({ type: "response.completed" }),
      "Codex sent output events that contradict each other",
    ],
    [
      "finished call arguments contradicting partial streamed arguments",
      added(0, "call-a") +
        deltaArgs(0, '{"key":"a') +
        itemDoneArgs(0, JSON.stringify({ key: "b" })) +
        sse({ type: "response.completed" }),
      "Codex sent output events that contradict each other",
    ],
    [
      "terminal output listing reasoning with other reasoning content",
      reasoningWith(1, "r1", "S", "X") +
        completedWith([
          listedCallB,
          {
            type: "reasoning",
            id: "r1",
            summary: [{ type: "summary_text", text: "S" }],
            content: [{ type: "reasoning_text", text: "Y" }],
          },
        ]),
      "Codex completed a response whose output contradicts its stream",
    ],
    [
      "an incomplete terminal listing reasoning with unrepresentable content",
      incomplete([
        { type: "reasoning", id: "r9", summary: [], content: [{ type: "output_audio" }] },
      ]),
      "Codex sent incomplete reasoning",
    ],
    [
      "an incomplete terminal listing a finished message with other content",
      assistantMessage(1, "m1", "hi") +
        incomplete([{ type: "message", id: "m1", status: "incomplete", content: [text("bye")] }]),
      "Codex completed a response whose output contradicts its stream",
    ],
  ])("pass18: fails a mixed group with %s before any dispatch", async (_, body, description) => {
    const outcome = await turn(callB + body, { custom: true });
    expectNothingDispatched(outcome, description);
    expect(outcome.usage?.physicalRequests).toBe(1);
  });

  it.each([
    ["semantically equal", JSON.stringify({ key: "a" }), '{ "key" : "a" }'],
    ["completing a prefix", '{"key":', JSON.stringify({ key: "a" })],
  ])(
    "pass18: dispatches a call finished with arguments %s to its stream",
    async (_, delta, done) => {
      const outcome = await turn(
        added(0, "call-a") +
          deltaArgs(0, delta) +
          itemDoneArgs(0, done) +
          sse({ type: "response.completed" }),
        { custom: true },
      );
      expect(outcome.log).toEqual(["first:start", "first:end"]);
    },
  );

  it.each([
    ["finished content", [text("AB")]],
    ["sparse done content", undefined],
  ])("pass18: keeps a seeded indexed text prefix with %s", async (_, content) => {
    const outcome = await turn(
      started(0, "m0") +
        ev("response.content_part.added", {
          ...at(0, "m0"),
          content_index: 0,
          part: { type: "output_text", text: "A" },
        }) +
        ev("response.output_text.delta", { ...at(0, "m0"), content_index: 0, delta: "B" }) +
        ev("response.output_text.done", { ...at(0, "m0"), content_index: 0, text: "AB" }) +
        itemDone(
          0,
          content === undefined
            ? { type: "message", id: "m0" }
            : { type: "message", id: "m0", content },
        ) +
        sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(textParts(outcome)).toEqual([{ text: "AB", refusal: undefined }]);
  });

  it("pass18: keeps buffered indexed refusal and summary content of an incomplete response", async () => {
    const outcome = await turn(
      started(0, "m0") +
        ev("response.output_text.delta", { ...at(0, "m0"), content_index: 0, delta: "A" }) +
        ev("response.refusal.done", { ...at(0, "m0"), content_index: 1, refusal: "R" }) +
        reasoningStarted(1, "r1") +
        ev("response.reasoning_summary_text.done", {
          ...at(1, "r1"),
          summary_index: 0,
          text: "S",
        }) +
        incomplete(),
      { custom: true },
    );
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
      _tag: "Incomplete",
    });
    expect(textParts(outcome, "Incomplete")).toEqual([
      { text: "A", refusal: undefined },
      { text: "", refusal: "R" },
      { reasoning: "S" },
    ]);
  });

  it("pass18: keeps the Codex CLI's non-empty message start of an incomplete response", async () => {
    const outcome = await turn(
      ev("response.output_item.added", {
        item: { type: "message", role: "assistant", id: "msg-1", content: [text("hello")] },
      }) + incomplete(),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([{ text: "hello", refusal: undefined }]);
  });

  it("pass18: keeps a terminal-only reasoning summary of an incomplete response, not its content", async () => {
    const outcome = await turn(
      incomplete([
        {
          type: "reasoning",
          id: "r9",
          summary: [{ type: "summary_text", text: "S" }],
          content: [{ type: "reasoning_text", text: "private" }],
        },
      ]),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([{ reasoning: "S" }]);
    expect(JSON.stringify(outcome.exit)).not.toContain("private");
  });

  it("pass18: dispatches a group whose terminal lists the same reasoning content", async () => {
    const outcome = await turn(
      callA +
        reasoningWith(1, "r1", "S", "X") +
        completedWith([
          listedCall(),
          {
            type: "reasoning",
            id: "r1",
            summary: [{ type: "summary_text", text: "S" }],
            content: [{ type: "reasoning_text", text: "X" }],
          },
        ]),
      { custom: true },
    );
    expect(outcome.log).toEqual(["first:start", "first:end"]);
  });

  const incompleteMessage = (id: string, content: ReadonlyArray<Json>) => ({
    type: "message",
    id,
    role: "assistant",
    status: "incomplete",
    content: [...content],
  });
  const fullCall = {
    type: "function_call",
    id: "f",
    call_id: "call-f",
    name: "first",
    arguments: JSON.stringify({ key: "a" }),
    status: "completed",
  };
  const toolCallsOf = (outcome: Outcome) =>
    Exit.isSuccess(outcome.exit)
      ? Schema.decodeUnknownSync(
          Schema.Struct({
            _tag: Schema.Literal("Incomplete"),
            response: Schema.Struct({
              content: Schema.Array(
                Schema.Struct({
                  type: Schema.String,
                  id: Schema.optional(Schema.String),
                  name: Schema.optional(Schema.String),
                  params: Schema.optional(Schema.Json),
                }),
              ),
            }),
          }),
        )(outcome.exit.value).response.content.filter((part) => part.type === "tool-call")
      : [];
  const reasoningMetadataOf = (outcome: Outcome) => JSON.stringify(outcome.exit);

  it("pass19: keeps a started empty message's listed Incomplete content", async () => {
    const outcome = await turn(
      started(0, "m") + incomplete([incompleteMessage("m", [text("x"), refusalR])]),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([
      { text: "x", refusal: undefined },
      { text: "", refusal: "R" },
    ]);
    expect(outcome.log).toEqual([]);
    // Only the staged user message: nothing of the Incomplete response is committed.
    expect(outcome.history.map((message) => message.role)).toEqual(["user"]);
  });

  it("pass19: keeps a started reasoning item's listed Incomplete summary", async () => {
    const outcome = await turn(
      reasoningStarted(0, "r") +
        incomplete([
          { type: "reasoning", id: "r", summary: [{ type: "summary_text", text: "S" }] },
        ]),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([{ reasoning: "S" }]);
  });

  it.each([
    ["omits its content", []],
    ["repeats its content", [text("seen")]],
  ])(
    "pass19: keeps a streamed message's text once when its Incomplete listing %s",
    async (_, content) => {
      const outcome = await turn(
        started(0, "m") +
          ev("response.output_text.delta", { output_index: 0, delta: "seen" }) +
          incomplete([incompleteMessage("m", content)]),
        { custom: true },
      );
      expect(textParts(outcome, "Incomplete")).toEqual([{ text: "seen", refusal: undefined }]);
    },
  );

  it("pass19: keeps the Codex CLI's reasoning start summary and encrypted content on Incomplete", async () => {
    const outcome = await turn(
      ev("response.output_item.added", {
        output_index: 0,
        item: {
          type: "reasoning",
          id: "r",
          summary: [{ type: "summary_text", text: "S" }],
          encrypted_content: "EC",
        },
      }) + incomplete(),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([{ reasoning: "S" }]);
    expect(reasoningMetadataOf(outcome)).toContain('"encryptedContent":"EC"');
  });

  it("pass19: keeps a terminal-only empty-summary reasoning item's encrypted content, not its text", async () => {
    const outcome = await turn(
      incomplete([
        {
          type: "reasoning",
          id: "r9",
          summary: [],
          encrypted_content: "EC",
          content: [{ type: "reasoning_text", text: "private" }],
        },
      ]),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([{ reasoning: "" }]);
    expect(reasoningMetadataOf(outcome)).toContain('"encryptedContent":"EC"');
    expect(reasoningMetadataOf(outcome)).not.toContain("private");
  });

  it("pass19: keeps a fully supplied listed call of an Incomplete response as data, undispatched", async () => {
    const outcome = await turn(callA + incomplete([fullCall]), { custom: true });
    expect(toolCallsOf(outcome)).toEqual([
      expect.objectContaining({ type: "tool-call", id: "call-a" }),
      expect.objectContaining({
        type: "tool-call",
        id: "call-f",
        name: "first",
        params: { key: "a" },
      }),
    ]);
    expect(outcome.log).toEqual([]);
    // Only the staged user message: nothing of the Incomplete response is committed.
    expect(outcome.history.map((message) => message.role)).toEqual(["user"]);
    expect(outcome.usage?.dispatches).toBe(0);
  });

  it("pass19: keeps a fully supplied unfinished call of an Incomplete response as data", async () => {
    const outcome = await turn(
      added(0, "call-u") +
        itemDone(0, {
          type: "function_call",
          arguments: JSON.stringify({ key: "u" }),
          status: "incomplete",
        }) +
        incomplete(),
      { custom: true },
    );
    expect(toolCallsOf(outcome)).toEqual([
      expect.objectContaining({ id: "call-u", name: "first", params: { key: "u" } }),
    ]);
    expect(outcome.log).toEqual([]);
    expect(outcome.usage?.dispatches).toBe(0);
  });

  it("pass19: does not show a partially supplied listed call of an Incomplete response", async () => {
    const outcome = await turn(
      incomplete([
        { type: "function_call", call_id: "call-p", name: "first", arguments: '{"key":' },
      ]),
      { custom: true },
    );
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
      _tag: "Incomplete",
    });
    expect(toolCallsOf(outcome)).toEqual([]);
  });

  it.each([
    [
      "an Incomplete listed call with a malformed name",
      incomplete([{ ...fullCall, name: 42 }]),
      "Codex sent an incomplete Tool call",
    ],
    [
      "an Incomplete list repeating an item id",
      incomplete([incompleteMessage("m", [text("A")]), incompleteMessage("m", [text("B")])]),
      "Codex completed a response whose output contradicts its stream",
    ],
    [
      "an Incomplete list repeating a call id",
      incomplete([fullCall, { ...fullCall, id: "g" }]),
      "Codex completed a response whose output contradicts its stream",
    ],
    [
      "an Incomplete listed reasoning summary of another type",
      incomplete([{ type: "reasoning", id: "r9", summary: [{ type: "output_audio", text: "S" }] }]),
      "Codex sent incomplete reasoning",
    ],
    [
      "a terminal listing reasoning with a summary of another type",
      reasoningDone(1, "r1", ["S"]) +
        completedWith([
          listedCallB,
          { type: "reasoning", id: "r1", summary: [{ type: "output_audio", text: "S" }] },
        ]),
      "Codex completed a response whose output contradicts its stream",
    ],
    [
      "a reasoning summary part event of another type",
      reasoningStarted(1, "r1") +
        ev("response.reasoning_summary_part.added", {
          ...at(1, "r1"),
          summary_index: 0,
          part: { type: "output_audio", text: "" },
        }) +
        reasoningDone(1, "r1", []) +
        sse({ type: "response.completed" }),
      "Codex sent incomplete reasoning",
    ],
    [
      "a reasoning start summary of another type",
      ev("response.output_item.added", {
        output_index: 1,
        item: { type: "reasoning", id: "r1", summary: [{ type: "output_audio", text: "S" }] },
      }) +
        reasoningDone(1, "r1", []) +
        sse({ type: "response.completed" }),
      "Codex sent incomplete reasoning",
    ],
  ])("pass19: fails a mixed group with %s before any dispatch", async (_, body, description) => {
    const outcome = await turn(callB + body, { custom: true });
    expectNothingDispatched(outcome, description);
    expect(outcome.usage?.physicalRequests).toBe(1);
  });

  const seen = { text: "seen", refusal: undefined };
  const shownR = { text: "", refusal: "R" };
  const streamedSeen =
    started(0, "m") + ev("response.output_text.delta", { output_index: 0, delta: "seen" });
  const indexedSeen =
    started(0, "m") +
    ev("response.output_text.delta", { ...at(0, "m"), content_index: 0, delta: "seen" });
  const messageStart = (index: number, id: string, content: ReadonlyArray<Json>) =>
    ev("response.output_item.added", {
      output_index: index,
      item: { type: "message", id, content: [...content] },
    });
  const reasoningOpened = (fields: Record<string, Json>) =>
    ev("response.output_item.added", {
      output_index: 0,
      item: { type: "reasoning", id: "r", summary: [], ...fields },
    });
  const listedReasoningR = (fields: Record<string, Json>) => ({
    type: "reasoning",
    id: "r",
    summary: [{ type: "summary_text", text: "S" }],
    ...fields,
  });
  const summaryS = [{ type: "summary_text", text: "S" }];

  it.each([
    ["after streamed text", streamedSeen, [text("seen"), refusalR], [seen, shownR]],
    ["before streamed text", streamedSeen, [refusalR, text("seen")], [shownR, seen]],
    ["after an indexed text part", indexedSeen, [text("seen"), refusalR], [seen, shownR]],
    [
      "before an indexed refusal part",
      started(0, "m") +
        ev("response.refusal.done", { ...at(0, "m"), content_index: 1, refusal: "R" }),
      [text("seen"), refusalR],
      [seen, shownR],
    ],
    [
      "after a start's text",
      messageStart(0, "m", [text("seen")]),
      [text("seen"), refusalR],
      [seen, shownR],
    ],
  ])(
    "merges an open message's Incomplete listing that adds a refusal %s",
    async (_, stream, listed, shown) => {
      const outcome = await turn(stream + incomplete([incompleteMessage("m", listed)]), {
        custom: true,
      });
      expect(textParts(outcome, "Incomplete")).toEqual(shown);
      expect(outcome.log).toEqual([]);
      expect(outcome.usage?.dispatches).toBe(0);
      // Only the staged user message: nothing of the Incomplete response is committed.
      expect(outcome.history.map((entry) => entry.role)).toEqual(["user"]);
    },
  );

  it.each([
    ["other text", streamedSeen, [text("other"), refusalR]],
    ["another indexed part type", indexedSeen, [refusalR, text("seen")]],
  ])(
    "keeps an open message's own content, not its Incomplete listing with %s",
    async (_, stream, listed) => {
      const outcome = await turn(stream + incomplete([incompleteMessage("m", listed)]), {
        custom: true,
      });
      expect(textParts(outcome, "Incomplete")).toEqual([seen]);
    },
  );

  it("merges each open message's Incomplete listing into that message only", async () => {
    const outcome = await turn(
      started(0, "m0") +
        ev("response.output_text.delta", { output_index: 0, item_id: "m0", delta: "A" }) +
        started(1, "m1") +
        ev("response.output_text.delta", { output_index: 1, item_id: "m1", delta: "B" }) +
        incomplete([incompleteMessage("m1", [text("B"), refusalR])]),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([
      { text: "A", refusal: undefined },
      { text: "B", refusal: undefined },
      shownR,
    ]);
  });

  it.each([
    [
      "a start's summary",
      reasoningOpened({ summary: summaryS }),
      listedReasoningR({ encrypted_content: "EC" }),
    ],
    [
      "an indexed streamed summary",
      reasoningStarted(0, "r") +
        ev("response.reasoning_summary_text.delta", {
          ...at(0, "r"),
          summary_index: 0,
          delta: "S",
        }),
      listedReasoningR({ encrypted_content: "EC" }),
    ],
    [
      "a start's encrypted content",
      reasoningOpened({ encrypted_content: "EC" }),
      listedReasoningR({}),
    ],
    ["nothing retained", reasoningOpened({}), listedReasoningR({ encrypted_content: "EC" })],
  ])("merges an open reasoning item's Incomplete listing beside %s", async (_, stream, listed) => {
    const outcome = await turn(stream + incomplete([listed]), { custom: true });
    expect(textParts(outcome, "Incomplete")).toEqual([{ reasoning: "S" }]);
    expect(reasoningMetadataOf(outcome)).toContain('"encryptedContent":"EC"');
    expect(outcome.log).toEqual([]);
  });

  it("keeps an open reasoning item's own encrypted content, not a listing's other one", async () => {
    const outcome = await turn(
      reasoningOpened({ summary: summaryS, encrypted_content: "EC1" }) +
        incomplete([listedReasoningR({ encrypted_content: "EC2" })]),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([{ reasoning: "S" }]);
    expect(reasoningMetadataOf(outcome)).toContain('"encryptedContent":"EC1"');
    expect(reasoningMetadataOf(outcome)).not.toContain("EC2");
  });

  const finalizedCall =
    added(0, "call-a") +
    ev("response.function_call_arguments.done", {
      output_index: 0,
      arguments: JSON.stringify({ key: "a" }),
    });
  const sparseUnfinished = itemDone(0, { type: "function_call", status: "incomplete" });

  it.each([
    ["a sparse unfinished done item", finalizedCall + sparseUnfinished + incomplete()],
    [
      "a sparse Incomplete listing",
      finalizedCall + incomplete([{ type: "function_call", id: "item-0", status: "incomplete" }]),
    ],
    ["an Incomplete response without a listing", finalizedCall + incomplete()],
  ])("keeps a call's finalized arguments through %s as data, undispatched", async (_, body) => {
    const outcome = await turn(body, { custom: true });
    expect(toolCallsOf(outcome)).toEqual([
      expect.objectContaining({
        type: "tool-call",
        id: "call-a",
        name: "first",
        params: { key: "a" },
      }),
    ]);
    expect(outcome.log).toEqual([]);
    expect(outcome.usage?.dispatches).toBe(0);
    expect(outcome.history.map((entry) => entry.role)).toEqual(["user"]);
  });

  it("does not show a call's unfinalized streamed arguments through a sparse unfinished done item", async () => {
    const outcome = await turn(
      added(0, "call-a") +
        deltaArgs(0, JSON.stringify({ key: "a" })) +
        sparseUnfinished +
        incomplete(),
      { custom: true },
    );
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
      _tag: "Incomplete",
    });
    expect(toolCallsOf(outcome)).toEqual([]);
  });

  it("dispatches a call whose sparse completed done item follows its final arguments", async () => {
    const outcome = await turn(
      finalizedCall + itemDone(0, { type: "function_call" }) + sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(outcome.log).toEqual(["first:start", "first:end"]);
  });

  it("fails the default loop on finalized arguments of an Incomplete response, committing nothing", async () => {
    const outcome = await turn(finalizedCall + sparseUnfinished + incomplete(), { custom: false });
    expect(squashed(outcome.exit)).toMatchObject({
      _tag: "IncompleteStepError",
      reason: "length",
    });
    expect(outcome.log).toEqual([]);
    expect(outcome.usage?.dispatches).toBe(0);
    expect(outcome.history).toEqual([]);
  });

  it.each([
    [
      "a message start's text",
      messageStart(0, "m0", [text("A"), refusalR]) +
        ev("response.output_text.delta", { ...at(0, "m0"), content_index: 0, delta: "B" }) +
        itemDone(0, { type: "message", id: "m0", content: [text("AB"), refusalR] }),
      [{ text: "AB", refusal: undefined }, shownR],
    ],
    [
      "a message start's text, finished sparsely",
      messageStart(0, "m0", [text("A"), refusalR]) +
        ev("response.output_text.delta", { ...at(0, "m0"), content_index: 0, delta: "B" }) +
        itemDone(0, { type: "message", id: "m0" }),
      [{ text: "AB", refusal: undefined }, shownR],
    ],
    [
      "a reasoning start's summary",
      reasoningOpened({ summary: summaryS }) +
        ev("response.reasoning_summary_text.delta", {
          ...at(0, "r"),
          summary_index: 0,
          delta: "T",
        }) +
        reasoningDone(0, "r", ["ST"]),
      [{ reasoning: "ST" }],
    ],
    [
      "a reasoning summary part's text",
      reasoningStarted(0, "r") +
        ev("response.reasoning_summary_part.added", {
          ...at(0, "r"),
          summary_index: 0,
          part: { type: "summary_text", text: "S" },
        }) +
        ev("response.reasoning_summary_text.delta", {
          ...at(0, "r"),
          summary_index: 0,
          delta: "T",
        }) +
        reasoningDone(0, "r", ["ST"]),
      [{ reasoning: "ST" }],
    ],
    [
      "a message start's text, without an index (the separate locator-less part)",
      messageStart(0, "m0", [text("A")]) +
        ev("response.output_text.delta", { output_index: 0, delta: "B" }) +
        itemDone(0, { type: "message", id: "m0", content: [text("B")] }),
      [{ text: "B", refusal: undefined }],
    ],
  ])("appends indexed deltas to %s", async (_, stream, shown) => {
    const outcome = await turn(stream + sse({ type: "response.completed" }), { custom: true });
    expect(squashed(outcome.exit)).toBeUndefined();
    expect(textParts(outcome)).toEqual(shown);
  });

  it("keeps a message start's text with its indexed delta on Incomplete", async () => {
    const outcome = await turn(
      messageStart(0, "m0", [text("A")]) +
        ev("response.output_text.delta", { ...at(0, "m0"), content_index: 0, delta: "B" }) +
        incomplete(),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([{ text: "AB", refusal: undefined }]);
  });

  it("fails a message whose done content drops its start's text before an indexed delta", async () => {
    const outcome = await turn(
      callB +
        messageStart(0, "m0", [text("A")]) +
        ev("response.output_text.delta", { ...at(0, "m0"), content_index: 0, delta: "B" }) +
        itemDone(0, { type: "message", id: "m0", content: [text("B")] }) +
        sse({ type: "response.completed" }),
      { custom: true },
    );
    expectNothingDispatched(
      outcome,
      "Codex finished a message whose content contradicts its stream",
    );
  });

  const callF = (done: boolean) =>
    ev("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "f", call_id: "call-c", name: "first" },
    }) + (done ? doneAt(0) : "");
  const listedC = (id: string) => ({ ...fullCall, id, call_id: "call-c" });

  it.each([
    ["a completed", true],
    ["an open", false],
  ])("fails an Incomplete listing %s call's call id under another item id", async (_, done) => {
    const outcome = await turn(callF(done) + incomplete([listedC("g")]), { custom: true });
    expectNothingDispatched(
      outcome,
      "Codex completed a response whose output contradicts its stream",
    );
  });

  it("keeps a completed call an Incomplete response lists under its own item id, undispatched", async () => {
    const outcome = await turn(callF(true) + incomplete([listedC("f")]), { custom: true });
    expect(toolCallsOf(outcome)).toEqual([
      expect.objectContaining({ id: "call-c", name: "first", params: { key: "a" } }),
    ]);
    expect(outcome.log).toEqual([]);
    expect(outcome.history.map((entry) => entry.role)).toEqual(["user"]);
  });

  it("keeps a reasoning start's summary through an empty locator-less summary part", async () => {
    const outcome = await turn(
      reasoningOpened({ summary: summaryS }) +
        ev("response.reasoning_summary_part.added", {
          ...at(0, "r"),
          part: { type: "summary_text", text: "" },
        }) +
        incomplete(),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([{ reasoning: "S" }]);
    expect(outcome.log).toEqual([]);
    expect(outcome.usage?.dispatches).toBe(0);
  });

  it("replaces a reasoning start's summary with later locator-less summary text", async () => {
    const outcome = await turn(
      reasoningOpened({ summary: summaryS }) +
        ev("response.reasoning_summary_part.added", {
          ...at(0, "r"),
          part: { type: "summary_text", text: "" },
        }) +
        ev("response.reasoning_summary_text.delta", { ...at(0, "r"), delta: "T" }) +
        incomplete(),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([{ reasoning: "T" }]);
  });

  const unfinishedDone = (content: ReadonlyArray<Json>) =>
    itemDone(0, { type: "message", id: "m", status: "incomplete", content: [...content] });

  it.each([
    [
      "done-only, adding a refusal",
      started(0, "m") + unfinishedDone([text("A")]),
      [text("A"), refusalR],
      [{ text: "A", refusal: undefined }, shownR],
    ],
    [
      "streamed, adding a refusal",
      streamedSeen + unfinishedDone([text("seen")]),
      [text("seen"), refusalR],
      [seen, shownR],
    ],
    [
      "indexed and sparse, not a part of another type",
      indexedSeen + itemDone(0, { type: "message", id: "m", status: "incomplete" }),
      [refusalR],
      [seen],
    ],
    [
      "indexed and sparse, adding a refusal",
      indexedSeen + itemDone(0, { type: "message", id: "m", status: "incomplete" }),
      [text("seen"), refusalR],
      [seen, shownR],
    ],
    [
      "done-only, not other content",
      started(0, "m") + unfinishedDone([text("A")]),
      [text("B"), refusalR],
      [{ text: "A", refusal: undefined }],
    ],
    [
      "done-only, without a listing",
      started(0, "m") + unfinishedDone([text("A"), refusalR]),
      undefined,
      [{ text: "A", refusal: undefined }, shownR],
    ],
  ])(
    "merges an Incomplete listing into a message finished with status incomplete: %s",
    async (_, stream, listed, shown) => {
      const outcome = await turn(
        stream + incomplete(listed === undefined ? [] : [incompleteMessage("m", listed)]),
        { custom: true },
      );
      expect(textParts(outcome, "Incomplete")).toEqual(shown);
      expect(outcome.log).toEqual([]);
      expect(outcome.usage?.dispatches).toBe(0);
      expect(outcome.history.map((entry) => entry.role)).toEqual(["user"]);
    },
  );

  const messageDone = (index: number, id: string, value: string, status = "completed") =>
    itemDone(index, { type: "message", id, status, content: [text(value)] });
  const shownAs = (value: string) => ({ text: value, refusal: undefined });
  const unfinishedThenCompleted =
    started(0, "m0") +
    messageDone(0, "m0", "A", "incomplete") +
    started(1, "m1") +
    messageDone(1, "m1", "B");

  it.each([
    [
      "an unfinished message before a completed one",
      unfinishedThenCompleted,
      [],
      [shownAs("A"), shownAs("B")],
    ],
    [
      "an unfinished message its listing enriches, before a completed one",
      unfinishedThenCompleted,
      [incompleteMessage("m0", [text("A"), refusalR])],
      [shownAs("A"), shownR, shownAs("B")],
    ],
    [
      "an open message before a completed one (the open message last)",
      started(0, "m0") +
        ev("response.output_text.delta", { output_index: 0, delta: "A" }) +
        started(1, "m1") +
        messageDone(1, "m1", "B"),
      [],
      [shownAs("B"), shownAs("A")],
    ],
    [
      "an unfinished, an open and a completed message (the open message last)",
      started(0, "m0") +
        messageDone(0, "m0", "A", "incomplete") +
        started(1, "m1") +
        ev("response.output_text.delta", { output_index: 1, delta: "B" }) +
        started(2, "m2") +
        messageDone(2, "m2", "C"),
      [],
      [shownAs("A"), shownAs("C"), shownAs("B")],
    ],
  ])("keeps the order of %s on Incomplete", async (_, stream, listed, shown) => {
    const outcome = await turn(stream + incomplete(listed), { custom: true });
    expect(textParts(outcome, "Incomplete")).toEqual(shown);
    expect(outcome.log).toEqual([]);
    expect(outcome.usage?.dispatches).toBe(0);
  });

  it("merges the encrypted content an Incomplete listing adds to reasoning finished with status incomplete", async () => {
    const outcome = await turn(
      reasoningStarted(0, "r") +
        itemDone(0, { type: "reasoning", id: "r", status: "incomplete", summary: summaryS }) +
        incomplete([listedReasoningR({ encrypted_content: "EC" })]),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([{ reasoning: "S" }]);
    expect(reasoningMetadataOf(outcome)).toContain('"encryptedContent":"EC"');
    expect(outcome.log).toEqual([]);
  });

  it("fails text for a message after its done item with status incomplete", async () => {
    const outcome = await turn(
      callB +
        started(0, "m") +
        unfinishedDone([text("A")]) +
        ev("response.output_text.delta", { output_index: 0, delta: "B" }) +
        incomplete(),
      { custom: true },
    );
    expectNothingDispatched(outcome, "Codex sent text without a message item");
  });

  it("keeps the arguments an Incomplete listing supplies for a call finished without them", async () => {
    const outcome = await turn(
      added(0, "call-a") +
        sparseUnfinished +
        incomplete([{ ...listedCall(), status: "incomplete" }]),
      { custom: true },
    );
    expect(toolCallsOf(outcome)).toEqual([
      expect.objectContaining({ id: "call-a", name: "first", params: { key: "a" } }),
    ]);
    expect(outcome.log).toEqual([]);
    expect(outcome.usage?.dispatches).toBe(0);
  });

  it("keeps a call's own finished arguments over another listed value", async () => {
    const outcome = await turn(
      added(0, "call-a") +
        itemDone(0, {
          type: "function_call",
          arguments: JSON.stringify({ key: "a" }),
          status: "incomplete",
        }) +
        incomplete([
          { ...listedCall(), arguments: JSON.stringify({ key: "b" }), status: "incomplete" },
        ]),
      { custom: true },
    );
    expect(toolCallsOf(outcome)).toEqual([
      expect.objectContaining({ id: "call-a", params: { key: "a" } }),
    ]);
  });

  const partAdded = (part: Json) =>
    ev("response.content_part.added", { ...at(0, "m"), content_index: 0, part });
  const emptyText = { type: "output_text", text: "" };
  const sparseUnfinishedMessage = itemDone(0, { type: "message", id: "m", status: "incomplete" });
  const listedA = [incompleteMessage("m", [text("A")])];

  it.each([
    [
      "an unknown part through a sparse unfinished done item, filled by its listing",
      partAdded(emptyText) + sparseUnfinishedMessage,
      listedA,
      [shownAs("A")],
    ],
    [
      "an unknown part of an open message, filled by its listing",
      partAdded(emptyText),
      listedA,
      [shownAs("A")],
    ],
    // An omitted value is not shown as empty text: nothing supplied it.
    [
      "an unknown part through a sparse unfinished done item, without a listing (not shown)",
      partAdded(emptyText) + sparseUnfinishedMessage,
      [],
      [],
    ],
    [
      "an unknown refusal part, filled by its listing",
      partAdded({ type: "refusal", refusal: "" }) + sparseUnfinishedMessage,
      [incompleteMessage("m", [refusalR])],
      [shownR],
    ],
    [
      "an explicitly empty part through a sparse unfinished done item, not its listing's text",
      ev("response.content_part.done", { ...at(0, "m"), content_index: 0, part: emptyText }) +
        sparseUnfinishedMessage,
      listedA,
      [shownAs("")],
    ],
    [
      "an explicitly empty part through a sparse unfinished done item, without a listing",
      ev("response.content_part.done", { ...at(0, "m"), content_index: 0, part: emptyText }) +
        sparseUnfinishedMessage,
      [],
      [shownAs("")],
    ],
  ])("keeps %s on Incomplete", async (_, events, listed, shown) => {
    const outcome = await turn(started(0, "m") + events + incomplete(listed), { custom: true });
    expect(textParts(outcome, "Incomplete")).toEqual(shown);
    expect(outcome.log).toEqual([]);
    expect(outcome.usage?.dispatches).toBe(0);
    expect(outcome.history.map((entry) => entry.role)).toEqual(["user"]);
  });

  it("finishes an unknown part of a completed sparse done item as empty text", async () => {
    const outcome = await turn(
      started(0, "m") +
        partAdded(emptyText) +
        itemDone(0, { type: "message", id: "m" }) +
        sse({ type: "response.completed" }),
      { custom: true },
    );
    expect(textParts(outcome)).toEqual([shownAs("")]);
  });

  const emptySummaryPart = ev("response.reasoning_summary_part.added", {
    ...at(0, "r"),
    part: { type: "summary_text", text: "" },
  });
  const summaryDelta = (delta: string) =>
    ev("response.reasoning_summary_text.delta", { ...at(0, "r"), delta });
  const unfinishedReasoning = (fields: Record<string, Json>) =>
    itemDone(0, { type: "reasoning", id: "r", status: "incomplete", ...fields });

  it.each([
    [
      "a locator-less summary delta after two declared parts",
      reasoningOpened({}) +
        emptySummaryPart +
        ev("response.reasoning_summary_text.delta", {
          ...at(0, "r"),
          summary_index: 1,
          delta: "A",
        }) +
        summaryDelta("B") +
        incomplete(),
      "Codex sent a content event that names no single content part",
    ],
    [
      "a done summary omitting an empty declared part",
      reasoningOpened({}) + emptySummaryPart + unfinishedReasoning({ summary: [] }) + incomplete(),
      "Codex sent output events that contradict each other",
    ],
    [
      "a done summary omitting an empty part declared over a start's summary",
      reasoningOpened({ summary: summaryS }) +
        emptySummaryPart +
        unfinishedReasoning({ summary: [] }) +
        incomplete(),
      "Codex sent output events that contradict each other",
    ],
  ])("fails %s before any dispatch", async (_, body, description) => {
    const outcome = await turn(callB + body, { custom: true });
    expectNothingDispatched(outcome, description);
  });

  it("names an empty declared summary part with a locator-less delta", async () => {
    const outcome = await turn(
      reasoningOpened({}) + emptySummaryPart + summaryDelta("B") + incomplete(),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([{ reasoning: "B" }]);
  });

  it.each([
    ["omits it", {}, '"encryptedContent":"EC"'],
    ["states another", { encrypted_content: "EC2" }, '"encryptedContent":"EC2"'],
  ])(
    "keeps reasoning's encrypted content as its sparse unfinished done item %s",
    async (_, fields, shown) => {
      const outcome = await turn(
        reasoningOpened({ summary: summaryS, encrypted_content: "EC" }) +
          unfinishedReasoning({ summary: summaryS, ...fields }) +
          incomplete(),
        { custom: true },
      );
      expect(textParts(outcome, "Incomplete")).toEqual([{ reasoning: "S" }]);
      expect(reasoningMetadataOf(outcome)).toContain(shown);
      expect(outcome.log).toEqual([]);
      expect(outcome.usage?.dispatches).toBe(0);
    },
  );

  it("drops reasoning's encrypted content its unfinished done item states as null", async () => {
    const outcome = await turn(
      reasoningOpened({ summary: summaryS, encrypted_content: "EC" }) +
        unfinishedReasoning({ summary: summaryS, encrypted_content: null }) +
        incomplete(),
      { custom: true },
    );
    expect(textParts(outcome, "Incomplete")).toEqual([{ reasoning: "S" }]);
    expect(reasoningMetadataOf(outcome)).not.toContain("encryptedContent");
  });

  it.each([
    ["hides a listing contradicting", '{"key":"a', JSON.stringify({ key: "b" }), []],
    [
      "shows a listing completing",
      '{"key":',
      JSON.stringify({ key: "a" }),
      [expect.objectContaining({ id: "call-a", name: "first", params: { key: "a" } })],
    ],
  ])(
    "%s the partial streamed arguments of a call finished without its own",
    async (_, delta, listedArguments, shown) => {
      const outcome = await turn(
        added(0, "call-a") +
          deltaArgs(0, delta) +
          sparseUnfinished +
          incomplete([{ ...listedCall(), arguments: listedArguments, status: "incomplete" }]),
        { custom: true },
      );
      // A successful Incomplete, not a failure (whose tool calls would also be empty).
      expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
        _tag: "Incomplete",
      });
      expect(toolCallsOf(outcome)).toEqual(shown);
      expect(outcome.log).toEqual([]);
      expect(outcome.usage?.dispatches).toBe(0);
      expect(outcome.history.map((entry) => entry.role)).toEqual(["user"]);
    },
  );

  it("accepts a call finished through its item id alias", async () => {
    const body =
      added(0, "call-a") +
      doneAt(0) +
      added(1, "call-b", "second") +
      doneById(1) +
      sse({ type: "response.completed" });
    const outcome = await turn(body, { custom: true });
    expect(outcome.log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({ _tag: "Complete" });
  });

  it("keeps an explicitly incomplete response with an unfinished call as incomplete data", async () => {
    const body =
      added(0, "call-a") +
      doneAt(0) +
      added(1, "call-b", "second") +
      sse({
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_output_tokens" } },
      });
    const outcome = await turn(body, { custom: true });
    expect(outcome.log).toEqual([]);
    expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
      _tag: "Incomplete",
      reason: "length",
    });
    expect(outcome.history.map((entry) => entry.role)).toEqual(["user"]);
  });

  it.each([
    [undefined, "auto", ["first", "second"]],
    ["auto" as const, "auto", ["first", "second"]],
    ["none" as const, "none", ["first", "second"]],
    [{ oneOf: ["second" as const] }, "auto", ["second"]],
  ])("sends Tool choice %j as %s", async (toolChoice, wire, advertised) => {
    const outcome = await turn(sse({ type: "response.completed" }), { custom: true, toolChoice });
    expect(Exit.isSuccess(outcome.exit)).toBe(true);
    const body = outcome.requests[0]?.body ?? {};
    expect(body["tool_choice"]).toBe(wire);
    const tools = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
      body["tools"],
    );
    expect(tools.map((tool) => tool.name)).toEqual(advertised);
  });

  it.each([
    ["required" as const],
    [{ tool: "first" as const }],
    [{ mode: "required" as const, oneOf: ["first" as const] }],
  ])("rejects unsupported Tool choice %j before sending", async (toolChoice) => {
    const outcome = await turn(sse({ type: "response.completed" }), { custom: true, toolChoice });
    expect(outcome.requests).toEqual([]);
    expect(outcome.log).toEqual([]);
    expect(squashed(outcome.exit)).toMatchObject({
      _tag: "AiError",
      reason: { _tag: "InvalidUserInputError" },
    });
    expect(outcome.usage).toEqual({ generations: 1, dispatches: 0, physicalRequests: 0 });
  });
});

describe("bounded retry and fallback for local-function-only requests", () => {
  // The managed profile exposes only local function Tools, so a repeated generation can repeat
  // Provider work but never a local handler: dispatch follows only a complete, classified response.
  const codexModel = async (server: Upstream) =>
    providerModel(
      codex({
        configDirectory: await codexDirectory(),
        baseUrl: server.url,
        tokenUrl: `${server.url}/oauth/token`,
      }),
      "gpt-5.4",
    );
  // Every request advertised only local function Tools (no Provider-executed capability).
  const FunctionTools = Schema.Array(Schema.Struct({ type: Schema.Literal("function") }));
  const functionOnly = (server: Upstream) =>
    server.requests.every((request) => Schema.is(FunctionTools)(request.body["tools"]));

  it("Codex resends a request whose response was dropped after acceptance, dispatching once", async () => {
    const server = await upstream(
      "/codex/responses",
      ["dropped", "calls", "text"],
      codexReply,
      tokenEndpoint(false),
    );
    try {
      const outcome = await run(runTurn(await codexModel(server)));
      expect(Exit.isSuccess(outcome.exit)).toBe(true);
      // Three requests reached the upstream; the first was accepted and its reply lost.
      expect(server.requests.length).toBe(3);
      expect(server.requests[0]?.body).toEqual(server.requests[1]?.body);
      expect(functionOnly(server)).toBe(true);
      expect(outcome.log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
      expect(outcome.usage).toEqual({ generations: 2, dispatches: 2, physicalRequests: 3 });
    } finally {
      await server.stop();
    }
  });

  it("Codex stops after its three sends when every response is dropped, with nothing dispatched", async () => {
    const server = await upstream(
      "/codex/responses",
      ["dropped", "dropped", "dropped", "calls"],
      codexReply,
    );
    try {
      const outcome = await run(runTurn(await codexModel(server)));
      expect(Exit.isFailure(outcome.exit)).toBe(true);
      expect(server.requests.length).toBe(3);
      expect(outcome.log).toEqual([]);
      expect(outcome.history).toEqual([]);
      expect(outcome.usage).toEqual({ generations: 1, dispatches: 0, physicalRequests: 3 });
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["a body lost mid-stream", "partial" as const],
    ["a body without a terminal event", "unterminated" as const],
  ])("Codex does not retry %s and dispatches none of it", async (_, reply) => {
    const server = await upstream("/codex/responses", [reply, "calls"], codexReply);
    try {
      const outcome = await run(runTurn(await codexModel(server)));
      expect(squashed(outcome.exit)).toMatchObject({ _tag: "AiError" });
      expect(server.requests.length).toBe(1);
      expect(outcome.log).toEqual([]);
      expect(outcome.history).toEqual([]);
      expect(outcome.usage).toEqual({ generations: 1, dispatches: 0, physicalRequests: 1 });
    } finally {
      await server.stop();
    }
  });

  it("Codex's longest sequence is six sends: three, a credential refresh, then three", async () => {
    const server = await upstream(
      "/codex/responses",
      ["retryable", "retryable", "unauthorized", "retryable", "retryable", "calls", "text"],
      codexReply,
      tokenEndpoint(false),
    );
    try {
      const outcome = await run(runTurn(await codexModel(server)));
      expect(Exit.isSuccess(outcome.exit)).toBe(true);
      expect(server.requests.length).toBe(7);
      expect(server.other).toEqual(["/oauth/token"]);
      expect(outcome.log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
      expect(outcome.usage).toEqual({ generations: 2, dispatches: 2, physicalRequests: 7 });
    } finally {
      await server.stop();
    }
  });

  it("Codex fails on a second 401 without another refresh, dispatching nothing", async () => {
    const server = await upstream(
      "/codex/responses",
      ["unauthorized", "unauthorized", "calls"],
      codexReply,
      tokenEndpoint(false),
    );
    try {
      const outcome = await run(runTurn(await codexModel(server)));
      expect(Exit.isFailure(outcome.exit)).toBe(true);
      expect(server.requests.length).toBe(2);
      expect(server.other).toEqual(["/oauth/token"]);
      expect(outcome.log).toEqual([]);
      expect(outcome.usage).toEqual({ generations: 1, dispatches: 0, physicalRequests: 2 });
    } finally {
      await server.stop();
    }
  });

  it("interrupting the Turn during a Codex retry stops further sends and dispatches nothing", async () => {
    const server = await upstream("/codex/responses", ["retryable", "hang", "calls"], codexReply);
    try {
      const model = await codexModel(server);
      const outcome = await run(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeSession({
              persistence: "none",
              limits: firstPartyExecutionLimits,
            });
            const ran: Array<string> = [];
            const tools = yield* localTools(
              Kit,
              Kit.of({
                first: () => Effect.sync(() => (ran.push("first"), "a")),
                second: () => Effect.sync(() => (ran.push("second"), "b")),
              }),
            );
            let turn: Turn["Service"] | undefined;
            const fiber = yield* Effect.forkChild(
              session.run(
                Effect.gen(function* () {
                  turn = yield* Turn;
                  return yield* step({ tools });
                }).pipe(Effect.provide(model)),
              ),
            );
            while (server.requests.length < 2) yield* Effect.sleep(5);
            yield* Fiber.interrupt(fiber);
            const exit = yield* Fiber.await(fiber);
            const usage = turn === undefined ? undefined : yield* turn.usage;
            return { exit, usage, ran, history: yield* session.history };
          }),
        ),
      );
      expect(Exit.isFailure(outcome.exit) && Cause.hasInterruptsOnly(outcome.exit.cause)).toBe(
        true,
      );
      expect(server.requests.length).toBe(2);
      expect(outcome.ran).toEqual([]);
      expect(outcome.history).toEqual([]);
      expect(outcome.usage).toEqual({ generations: 1, dispatches: 0, physicalRequests: 2 });
    } finally {
      await server.stop();
    }
  });

  it("OpenAI does not resend a request whose response was dropped", async () => {
    for (const transport of ["http", undefined] as const) {
      responseCount = 0;
      const server = await upstream("/v1/responses", ["dropped", "calls"], openAiReply);
      try {
        const model = providerModel(
          openai(
            transport === undefined
              ? { apiKeyEnv: key, baseUrl: `${server.url}/v1` }
              : { apiKeyEnv: key, baseUrl: `${server.url}/v1`, transport },
          ),
          "gpt-5.6",
        );
        const outcome = await run(runTurn(model));
        expect(Exit.isFailure(outcome.exit)).toBe(true);
        expect(server.requests.length).toBe(1);
        expect(outcome.log).toEqual([]);
        expect(outcome.usage).toEqual({ generations: 1, dispatches: 0, physicalRequests: 1 });
      } finally {
        await server.stop();
      }
    }
  });

  it("OpenAI's native fallback repeats a later generation's request, not the earlier Tool calls", async () => {
    responseCount = 0;
    const server = await upstream("/v1/responses", ["calls", "rejected", "text"], openAiReply);
    try {
      const model = providerModel(
        openai({ apiKeyEnv: key, baseUrl: `${server.url}/v1` }),
        "gpt-5.6",
      );
      const outcome = await run(runTurn(model));
      expect(Exit.isSuccess(outcome.exit)).toBe(true);
      // The incremental request and its full-Prompt fallback both follow the completed calls.
      expect(outcome.log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
      const [, incremental, fallback] = server.requests;
      expect(incremental?.body["previous_response_id"]).toBe("resp-1");
      expect(fallback?.body["previous_response_id"]).toBeUndefined();
      const inputs = (request: typeof incremental) =>
        Schema.decodeUnknownSync(Schema.Array(Schema.Json))(request?.body["input"]).length;
      expect(inputs(fallback)).toBeGreaterThan(inputs(incremental));
      expect(functionOnly(server)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("OpenAI stops after one fallback when it is rejected too", async () => {
    responseCount = 0;
    const server = await upstream(
      "/v1/responses",
      ["calls", "rejected", "rejected", "text"],
      openAiReply,
    );
    try {
      const model = providerModel(
        openai({ apiKeyEnv: key, baseUrl: `${server.url}/v1` }),
        "gpt-5.6",
      );
      const outcome = await run(runTurn(model));
      expect(squashed(outcome.exit)).toMatchObject({ reason: { _tag: "InvalidRequestError" } });
      expect(server.requests.length).toBe(3);
      expect(outcome.log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
      expect(outcome.usage).toEqual({ generations: 2, dispatches: 2, physicalRequests: 3 });
    } finally {
      await server.stop();
    }
  });
});

describe.each(bindings)("Model redirects through $name", (binding) => {
  /**
   * A Model endpoint that redirects every Model request to a separate destination server, which
   * would answer. It records each request's path and headers; token requests are answered normally.
   */
  const redirecting = async (status: 307 | 308) => {
    const destination: Array<string> = [];
    const target = createServer((request, response) => {
      request.resume();
      destination.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    // SAFETY: a successfully listening TCP server returns AddressInfo.
    const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    const requests: Upstream["requests"] = [];
    const headers: Array<IncomingMessage["headers"]> = [];
    const other: Array<string> = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      request.resume();
      request.on("end", () => {
        if (path !== binding.modelPath) {
          other.push(path);
          return tokenEndpoint(false)(path, response);
        }
        // The default WebSocket construction's socket handshake is not a Model request.
        if (request.method !== "POST") {
          other.push(`${request.method} ${path}`);
          return void response.writeHead(400).end();
        }
        requests.push({ path, body: {} });
        headers.push(request.headers);
        response.writeHead(status, { location: `${targetUrl}${path}` }).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a successfully listening TCP server returns AddressInfo.
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const upstreamLike: Upstream = {
      url,
      requests,
      other,
      upgrades: () => 0,
      stop: async () => {
        server.closeAllConnections();
        target.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await new Promise<void>((resolve) => target.close(() => resolve()));
      },
    };
    return { upstream: upstreamLike, destination, headers };
  };
  // Codex retries a retryable transport failure through its existing schedule: three sends of the
  // original request, each counted. The others send once.
  const attempts = binding.name === "openai-codex" ? 3 : 1;

  it.each([307, 308] as const)(
    "does not follow a %s redirect: the destination receives nothing and every send is counted",
    async (status) => {
      const { upstream: server, destination } = await redirecting(status);
      try {
        const outcome = await run(runTurn(await binding.model(server), { custom: true }));
        expect(destination).toEqual([]);
        expect(server.requests.length).toBe(attempts);
        expect(Exit.isFailure(outcome.exit) && Cause.hasInterruptsOnly(outcome.exit.cause)).toBe(
          false,
        );
        expect(squashed(outcome.exit)).toMatchObject({ _tag: "AiError" });
        expect(outcome.log).toEqual([]);
        expect(outcome.history).toEqual([]);
        expect(outcome.usage).toEqual({
          generations: 1,
          dispatches: 0,
          physicalRequests: attempts,
        });
      } finally {
        await server.stop();
      }
    },
  );

  it("keeps rejecting redirects under a caller RequestInit, whose other options still apply", async () => {
    const { upstream: server, destination, headers } = await redirecting(307);
    try {
      const outcome = await run(
        runTurn(await binding.model(server), { custom: true }).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "follow",
            headers: { "x-caller-option": "kept" },
          }),
        ),
      );
      expect(destination).toEqual([]);
      expect(server.requests.length).toBe(attempts);
      expect(headers.every((header) => header["x-caller-option"] === "kept")).toBe(true);
      expect(Exit.isFailure(outcome.exit)).toBe(true);
      expect(outcome.log).toEqual([]);
      expect(outcome.usage?.physicalRequests).toBe(attempts);
    } finally {
      await server.stop();
    }
  });

  it("keeps rejecting redirects under a RequestInit supplied only around the Step", async () => {
    const { upstream: server, destination, headers } = await redirecting(308);
    try {
      const model = await binding.model(server);
      const outcome = await run(
        Effect.scoped(
          Effect.gen(function* () {
            // The binding is built without any RequestInit; the caller adds one per request.
            const context = yield* Layer.build(model);
            const session = yield* makeSession({
              persistence: "none",
              limits: firstPartyExecutionLimits,
            });
            const tools = yield* localTools(
              Kit,
              Kit.of({ first: () => Effect.succeed("a"), second: () => Effect.succeed("b") }),
            );
            return yield* Effect.exit(
              session.run(
                step({ tools }).pipe(
                  Effect.provideService(FetchHttpClient.RequestInit, {
                    redirect: "follow",
                    headers: { "x-caller-option": "per-request" },
                  }),
                  Effect.provideContext(context),
                ),
              ),
            );
          }),
        ),
      );
      expect(destination).toEqual([]);
      expect(server.requests.length).toBe(attempts);
      expect(headers.every((header) => header["x-caller-option"] === "per-request")).toBe(true);
      expect(Exit.isFailure(outcome)).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

describe("credential redirects are unchanged", () => {
  it("still follows a redirected Codex token refresh, then generates normally", async () => {
    const token: Array<string> = [];
    const server = await upstream("/codex/responses", ["text"], codexReply, (path, response) => {
      token.push(path);
      if (path === "/oauth/token") {
        return void response.writeHead(307, { location: "/oauth/token-moved" }).end();
      }
      tokenEndpoint(false)(path === "/oauth/token-moved" ? "/oauth/token" : path, response);
    });
    try {
      const model = providerModel(
        codex({
          // An expired Credential forces a refresh before the Model request.
          configDirectory: await codexDirectory(Date.now() - 1_000),
          baseUrl: server.url,
          tokenUrl: `${server.url}/oauth/token`,
        }),
        "gpt-5.4",
      );
      const outcome = await run(runTurn(model, { custom: true }));
      expect(token).toEqual(["/oauth/token", "/oauth/token-moved"]);
      expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
        _tag: "Complete",
      });
      expect(outcome.usage?.physicalRequests).toBe(1);
    } finally {
      await server.stop();
    }
  });
});

describe.each(bindings.filter((binding) => binding.name.startsWith("openai (")))(
  "OpenAI response status through $name",
  (binding) => {
    const withBody = async (body: Record<string, Json>, custom: boolean) => {
      const server = await upstream(binding.modelPath, ["text"], (_, response) =>
        json(response, 200, body),
      );
      try {
        return await run(runTurn(await binding.model(server), { custom }));
      } finally {
        await server.stop();
      }
    };
    const calls = [functionCall(1, "first", "a"), functionCall(2, "second", "b")];

    it("still completes and dispatches a completed or status-less response without details", async () => {
      const status = openAiResponse("resp-c", calls);
      const { status: _, ...statusless } = status;
      for (const body of [status, statusless]) {
        const outcome = await withBody(body, true);
        expect(outcome.log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
        expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
          _tag: "Complete",
        });
      }
    });

    it("still dispatches calls whose items carry no status", async () => {
      const unmarked = calls.map((call) => {
        const { status: _, ...rest } = call;
        return rest;
      });
      const status = openAiResponse("resp-m", unmarked);
      const { status: _, ...statusless } = status;
      for (const body of [status, statusless]) {
        const outcome = await withBody(body, true);
        expect(outcome.log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
        expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
          _tag: "Complete",
        });
      }
    });

    // MCP tool discovery is listing metadata, not a call awaiting a result: omitting it is harmless.
    const listing = { type: "mcp_list_tools", id: "mcpl-1", server_label: "srv", tools: [] };
    it("still dispatches beside MCP tool-discovery metadata", async () => {
      const completed = openAiResponse("resp-l", [listing, ...calls]);
      const { status: _, ...statusless } = completed;
      for (const body of [completed, statusless]) {
        const outcome = await withBody(body, true);
        expect(outcome.log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
        expect(Exit.isSuccess(outcome.exit) && outcome.exit.value).toMatchObject({
          _tag: "Complete",
        });
      }
    });
  },
);

describe("physical request qualification", () => {
  it("counts OpenAI's native non-incremental fallback in the default WebSocket transport", async () => {
    responseCount = 0;
    // The second Step first sends an incremental request; the upstream rejects it and native
    // generation resends the full Prompt: two Model requests for one generation.
    const server = await upstream("/v1/responses", ["calls", "rejected", "text"], openAiReply);
    try {
      const model = providerModel(
        openai({ apiKeyEnv: key, baseUrl: `${server.url}/v1` }),
        "gpt-5.6",
      );
      const outcome = await run(runTurn(model));
      expect(Exit.isSuccess(outcome.exit)).toBe(true);
      expect(server.requests.map((request) => request.body["previous_response_id"])).toEqual([
        undefined,
        "resp-1",
        undefined,
      ]);
      expect(outcome.usage).toEqual({ generations: 2, dispatches: 2, physicalRequests: 3 });
      // The default transport kept its socket; generation itself used the HTTP endpoint.
      expect(server.upgrades()).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it("does not fall back without the WebSocket transport's response tracking", async () => {
    responseCount = 0;
    const server = await upstream("/v1/responses", ["calls", "text"], openAiReply);
    try {
      const model = providerModel(
        openai({ apiKeyEnv: key, baseUrl: `${server.url}/v1`, transport: "http" }),
        "gpt-5.6",
      );
      const outcome = await run(runTurn(model));
      expect(server.requests.map((request) => request.body["previous_response_id"])).toEqual([
        undefined,
        undefined,
      ]);
      expect(outcome.usage?.physicalRequests).toBe(2);
      expect(server.upgrades()).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("counts Codex's existing retry and 401 re-execution, but not the token refresh", async () => {
    const server = await upstream(
      "/codex/responses",
      ["retryable", "calls", "unauthorized", "text"],
      codexReply,
      tokenEndpoint(false),
    );
    try {
      const model = providerModel(
        codex({
          configDirectory: await codexDirectory(),
          baseUrl: server.url,
          tokenUrl: `${server.url}/oauth/token`,
        }),
        "gpt-5.4",
      );
      const outcome = await run(runTurn(model));
      expect(Exit.isSuccess(outcome.exit)).toBe(true);
      expect(server.requests.length).toBe(4);
      expect(server.other).toEqual(["/oauth/token"]);
      expect(outcome.usage).toEqual({ generations: 2, dispatches: 2, physicalRequests: 4 });
    } finally {
      await server.stop();
    }
  });

  it("records zero requests when Codex fails before sending (refresh rejected)", async () => {
    const server = await upstream("/codex/responses", ["calls"], codexReply, tokenEndpoint(true));
    try {
      const model = providerModel(
        codex({
          configDirectory: await codexDirectory(Date.now() - 1_000),
          baseUrl: server.url,
          tokenUrl: `${server.url}/oauth/token`,
        }),
        "gpt-5.4",
      );
      const outcome = await run(runTurn(model));
      expect(Exit.isFailure(outcome.exit)).toBe(true);
      expect(server.requests).toEqual([]);
      expect(server.other).toEqual(["/oauth/token"]);
      expect(outcome.usage).toEqual({ generations: 1, dispatches: 0, physicalRequests: 0 });
    } finally {
      await server.stop();
    }
  });
});
