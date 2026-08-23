import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "@effect/vitest";
import { WebSocketServer } from "ws";
import { Cause, ConfigProvider, Effect, Exit, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { createSession, credentialDescriptor } from "@mitome/core";
import { agent, sse } from "../support.js";
import { openai } from "../../src/openai/index.js";

type Json = typeof Schema.Json.Type;
type JsonObject = { readonly [key: string]: Json };
interface FollowUpRequest {
  readonly input?: ReadonlyArray<JsonObject>;
}

const key = "MITOME_OPENAI_TEST_KEY";
const fakeFetch =
  (handle: (request: Request) => Response | Promise<Response>): typeof globalThis.fetch =>
  async (input, init) =>
    handle(new Request(input, init));
const run = <A, E>(
  effect: Effect.Effect<A, E>,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  config: Record<string, string> = { [key]: "synthetic-key" },
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
    ),
  );
const response = (id: string, output: ReadonlyArray<Json> = []) => ({
  id,
  object: "response",
  model: "gpt-5.6",
  created_at: 1,
  output,
});
const message = (id: string, text: string, status: "in_progress" | "completed") => ({
  id,
  type: "message",
  role: "assistant",
  status,
  content: text === "" ? [] : [{ type: "output_text", text, annotations: [] }],
});
const event = (type: string, data: JsonObject = {}) => ({
  type,
  ...data,
});
/** SSE frames for one output item: created → added → deltas → done → completed. */
const itemStream = (
  respId: string,
  inProgress: { readonly id: string } & JsonObject,
  deltaType: string,
  deltas: ReadonlyArray<string>,
  done: JsonObject,
): ReadonlyArray<string> => {
  let seq = 0;
  return [
    event("response.created", {
      sequence_number: ++seq,
      response: response(respId),
    }),
    event("response.output_item.added", {
      output_index: 0,
      sequence_number: ++seq,
      item: inProgress,
    }),
    ...deltas.map((delta) =>
      event(deltaType, {
        item_id: inProgress.id,
        output_index: 0,
        content_index: 0,
        delta,
        sequence_number: ++seq,
      }),
    ),
    event("response.output_item.done", {
      output_index: 0,
      sequence_number: ++seq,
      item: done,
    }),
    event("response.completed", {
      sequence_number: ++seq,
      response: response(respId, [done]),
    }),
  ].map(sse);
};
const textStream = (respId: string, msgId: string, deltas: ReadonlyArray<string>) =>
  itemStream(
    respId,
    message(msgId, "", "in_progress"),
    "response.output_text.delta",
    deltas,
    message(msgId, deltas.join(""), "completed"),
  );

describe("openai", () => {
  it("exposes its credential descriptor without building a Session", () => {
    expect(credentialDescriptor(openai({ apiKeyEnv: "MITOME_TEST_API_KEY" }))).toBe(
      "MITOME_TEST_API_KEY",
    );
  });

  it("passes model ids unchanged and streams official Responses output incrementally", async () => {
    const requests: Array<{
      readonly model: string;
      readonly stream: boolean;
      readonly authorization: string | null;
    }> = [];
    let releaseSecond!: () => void;
    const secondReleased = new Promise<void>((resolve) => (releaseSecond = resolve));
    let firstChunk!: () => void;
    const firstChunkSent = new Promise<void>((resolve) => (firstChunk = resolve));
    const fetch = fakeFetch(async (request) => {
      expect(new URL(request.url).pathname).toBe("/v1/responses");
      // SAFETY: this controlled client request is emitted from the OpenAI request schema.
      const body = (await request.json()) as {
        model: string;
        stream: boolean;
      };
      requests.push({
        model: body.model,
        stream: body.stream,
        authorization: request.headers.get("authorization"),
      });
      const frames = textStream("resp-1", "msg-1", ["hel", "lo"]);
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const enqueue = (value: string) => controller.enqueue(new TextEncoder().encode(value));
            // frames[0..2]: created, item added, first delta.
            for (const frame of frames.slice(0, 3)) enqueue(frame);
            firstChunk();
            await secondReleased;
            for (const frame of frames.slice(3)) enqueue(frame);
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    const provider = openai({
      apiKeyEnv: key,
      baseUrl: "https://test.invalid/v1/",
      transport: "http",
    });
    const events: Array<unknown> = [];
    let firstOutput!: () => void;
    const output = new Promise<void>((resolve) => (firstOutput = resolve));
    const turn = run(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(agent(provider, "gpt-5.6"));
          yield* Stream.runForEach(session.prompt("Hi"), (item) =>
            Effect.sync(() => {
              events.push(item);
              if (item.type === "model-output") firstOutput();
            }),
          );
        }),
      ),
      fetch,
    );
    await firstChunkSent;
    await output;
    expect(events).toEqual([{ type: "model-output", text: "hel" }]);
    releaseSecond();
    await turn;
    expect(events).toEqual([
      { type: "model-output", text: "hel" },
      { type: "model-output", text: "lo" },
      expect.objectContaining({ type: "response-complete", finishReason: "stop" }),
    ]);
    expect(requests).toEqual([
      {
        model: "gpt-5.6",
        stream: true,
        authorization: "Bearer synthetic-key",
      },
    ]);
  });

  it("rejects explicit WebSocket outside Bun and Node when selected", async () => {
    const nodeProcess = globalThis.process;
    vi.stubGlobal("process", undefined);
    try {
      const provider = openai({ apiKeyEnv: key, transport: "websocket" });
      await expect(
        run(
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* createSession(agent(provider, "gpt-5.6"));
              yield* Stream.runDrain(session.prompt("Hi"));
            }),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "TurnError",
        message: "OpenAI WebSocket transport requires a Bun or Node server runtime",
      });
    } finally {
      vi.stubGlobal("process", nodeProcess);
    }
  });

  it("fails first use when its environment credential is missing", async () => {
    const provider = openai({ apiKeyEnv: key });
    await expect(
      run(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* createSession(agent(provider, "gpt-5.6"));
            yield* Stream.runDrain(session.prompt("Hi"));
          }),
        ),
        globalThis.fetch,
        {},
      ),
    ).rejects.toMatchObject({
      _tag: "TurnError",
      message: `Environment variable ${key} is not set or empty`,
    });
  });

  it("surfaces backend model rejection after the request without preflight", async () => {
    let requests = 0;
    const fetch = fakeFetch(() => {
      requests += 1;
      return Response.json({ error: { message: "model not found" } }, { status: 404 });
    });
    const provider = openai({
      apiKeyEnv: key,
      baseUrl: "https://test.invalid/v1",
      transport: "http",
    });
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(agent(provider, "future-private-model"));
          return yield* Effect.exit(Stream.runDrain(session.prompt("Hi")));
        }),
      ),
      fetch,
    );
    expect(Cause.squash(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toMatchObject({
      _tag: "TurnError",
      cause: { reason: { _tag: "InvalidRequestError" } },
    });
    expect(requests).toBe(1);
  });

  it("uses one Responses WebSocket by default for Tool continuations", async () => {
    let upgrades = 0;
    let httpRequests = 0;
    const authorizations: Array<string | null> = [];
    const frames: Array<JsonObject> = [];
    const streamEvents = (...stream: ReadonlyArray<string>): ReadonlyArray<JsonObject> =>
      stream.map((frame) =>
        Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
          frame.slice("data: ".length),
        ),
      );
    const server = createServer((_request, response) => {
      httpRequests += 1;
      response.writeHead(500).end("WebSocket upgrade required");
    });
    const webSocketServer = new WebSocketServer({ server, path: "/v1/responses" });
    webSocketServer.on("connection", (socket, request) => {
      upgrades += 1;
      authorizations.push(request.headers.authorization ?? null);
      socket.on("message", (raw) => {
        // SAFETY: ws message payloads are binary-compatible with ArrayBuffer when not a Buffer.
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        const frame = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
        )(bytes.toString());
        frames.push(frame);
        if (frames.length === 1) {
          const functionCall = {
            type: "function_call",
            id: "fc-1",
            call_id: "call-1",
            name: "echo",
            arguments: '{"text":"hello"}',
            status: "completed",
          };
          for (const event of streamEvents(
            ...itemStream(
              "resp-tool",
              { ...functionCall, arguments: "", status: "in_progress" },
              "response.function_call_arguments.delta",
              ['{"text":"hello"}'],
              functionCall,
            ),
          ))
            socket.send(JSON.stringify(event));
          return;
        }
        for (const event of streamEvents(...textStream("resp-done", "msg-done", ["done"])))
          socket.send(JSON.stringify(event));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const echo = Tool.make("echo", {
        parameters: Schema.Struct({ text: Schema.String }),
        success: Schema.String,
      });
      const events = await run(
        Effect.scoped(
          Effect.gen(function* () {
            const provider = openai({
              apiKeyEnv: key,
              // SAFETY: the successfully listening TCP server has an AddressInfo address.
              baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            });
            const session = yield* createSession(
              agent(provider, "gpt-5.6", [
                {
                  name: "echo",
                  toolkit: Toolkit.make(echo),
                  handlers: {
                    // SAFETY: Toolkit validates handler parameters with the echo schema.
                    echo: (params) => Effect.succeed((params as { text: string }).text),
                  },
                },
              ]),
            );
            return yield* Stream.runCollect(session.prompt("Hi"));
          }),
        ),
      );
      expect([...events]).toEqual([
        { type: "tool-call", id: "call-1", name: "echo", params: { text: "hello" } },
        {
          type: "tool-result",
          id: "call-1",
          name: "echo",
          result: "hello",
          isFailure: false,
        },
        { type: "model-output", text: "done" },
        expect.objectContaining({ type: "response-complete", finishReason: "stop" }),
      ]);
      expect(upgrades).toBe(1);
      expect(authorizations).toEqual(["Bearer synthetic-key"]);
      expect(httpRequests).toBe(0);
      expect(frames).toHaveLength(2);
      expect(frames.map((frame) => frame.type)).toEqual(["response.create", "response.create"]);
      expect(frames.every((frame) => !("stream" in frame) && !("background" in frame))).toBe(true);
      expect(frames[1]).toMatchObject({ previous_response_id: "resp-tool" });
      expect(frames[1]?.input).toEqual([
        {
          type: "function_call_output",
          call_id: "call-1",
          output: '"hello"',
        },
      ]);
    } finally {
      webSocketServer.clients.forEach((socket) => socket.terminate());
      webSocketServer.close();
      server.closeAllConnections();
      server.close();
    }
  });

  it("maps Responses function calls through the Core Tool loop", async () => {
    let calls = 0;
    let followUp: FollowUpRequest = {};
    const fetch = fakeFetch(async (request) => {
      // SAFETY: this controlled client request is emitted from the OpenAI request schema.
      const body = (await request.json()) as {
        readonly tools?: ReadonlyArray<Json>;
        readonly input?: ReadonlyArray<JsonObject>;
      };
      calls += 1;
      if (calls === 1) {
        expect(body.tools).toHaveLength(1);
        const functionCall = {
          type: "function_call",
          id: "fc-1",
          call_id: "call-1",
          name: "echo",
          arguments: '{"text":"hello"}',
          status: "completed",
        };
        return new Response(
          itemStream(
            "resp-tool",
            { ...functionCall, arguments: "", status: "in_progress" },
            "response.function_call_arguments.delta",
            ['{"text":"hello"}'],
            functionCall,
          ).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      followUp = body;
      return new Response(textStream("resp-done", "msg-done", ["done"]).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const echo = Tool.make("echo", {
      parameters: Schema.Struct({ text: Schema.String }),
      success: Schema.String,
    });
    const provider = openai({
      apiKeyEnv: key,
      baseUrl: "https://test.invalid/v1",
      transport: "http",
    });
    const definition = agent(provider, "gpt-5.6", [
      {
        name: "echo",
        toolkit: Toolkit.make(echo),
        handlers: {
          // SAFETY: Toolkit validates handler parameters with the echo schema.
          echo: (params) => Effect.succeed((params as { text: string }).text),
        },
      },
    ]);
    const events = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(definition);
          return yield* Stream.runCollect(session.prompt("Hi"));
        }),
      ),
      fetch,
    );
    expect([...events]).toEqual([
      { type: "tool-call", id: "call-1", name: "echo", params: { text: "hello" } },
      {
        type: "tool-result",
        id: "call-1",
        name: "echo",
        result: "hello",
        isFailure: false,
      },
      { type: "model-output", text: "done" },
      expect.objectContaining({ type: "response-complete", finishReason: "stop" }),
    ]);
    expect(calls).toBe(2);
    expect(followUp.input).toContainEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: '"hello"',
    });
  });
});
