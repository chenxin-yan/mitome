// Bun
// Bun's async matchers are typed void but must be awaited to stay within the test.
// oxlint-disable typescript/await-thenable
import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { type AgentDefinition, createSession, credentialDescriptor } from "@mitome/core";
import { env, openai } from "../../src/openai/index.js";

const key = "MITOME_OPENAI_TEST_KEY";
const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const response = (id: string, output: ReadonlyArray<unknown> = []) => ({
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
const event = (type: string, data: Record<string, unknown> = {}) => ({
  type,
  ...data,
});
/** SSE frames for one output item: created → added → deltas → done → completed. */
const itemStream = (
  respId: string,
  inProgress: { readonly id: string } & Record<string, unknown>,
  deltaType: string,
  deltas: ReadonlyArray<string>,
  done: Record<string, unknown>,
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

const withKey = async <A>(run: () => Promise<A>): Promise<A> => {
  const previous = process.env[key];
  process.env[key] = "synthetic-key";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
};

describe("openai", () => {
  test("exposes its credential descriptor without building a Session", () => {
    expect(credentialDescriptor(openai("gpt-5.4-mini", env("MITOME_TEST_API_KEY")))).toBe(
      "MITOME_TEST_API_KEY",
    );
  });

  test("passes model ids unchanged and streams official Responses output incrementally", async () => {
    const requests: Array<{
      readonly model: string;
      readonly stream: boolean;
      readonly authorization: string | null;
    }> = [];
    let releaseSecond!: () => void;
    const secondReleased = new Promise<void>((resolve) => (releaseSecond = resolve));
    let firstChunk!: () => void;
    const firstChunkSent = new Promise<void>((resolve) => (firstChunk = resolve));
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        expect(new URL(request.url).pathname).toBe("/v1/responses");
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
          new ReadableStream({
            async start(controller) {
              // frames[0..2]: created, item added, first delta.
              for (const frame of frames.slice(0, 3)) controller.enqueue(frame);
              firstChunk();
              await secondReleased;
              for (const frame of frames.slice(3)) controller.enqueue(frame);
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    try {
      await withKey(async () => {
        const definition = (model: string): AgentDefinition => ({
          instructions: "Be concise.",
          model: openai(model, env(key), {
            baseUrl: `http://127.0.0.1:${server.port}/v1/`,
          }),
          plugins: [],
        });
        const events: Array<unknown> = [];
        let firstOutput!: () => void;
        const output = new Promise<void>((resolve) => (firstOutput = resolve));
        const turn = Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* createSession(definition("gpt-5.6"));
              yield* Stream.runForEach(session.prompt("Hi"), (item) =>
                Effect.sync(() => {
                  events.push(item);
                  if (item.type === "model-output") firstOutput();
                }),
              );
            }),
          ),
        );
        await firstChunkSent;
        await output;
        expect(events).toEqual([{ type: "model-output", text: "hel" }]);
        releaseSecond();
        await turn;
        expect(events).toEqual([
          { type: "model-output", text: "hel" },
          { type: "model-output", text: "lo" },
          { type: "response-complete" },
        ]);
      });
      expect(requests).toEqual([
        {
          model: "gpt-5.6",
          stream: true,
          authorization: "Bearer synthetic-key",
        },
      ]);
    } finally {
      void server.stop(true);
    }
  });

  test("fails session startup when its environment credential is missing", async () => {
    const previous = process.env[key];
    delete process.env[key];
    try {
      const model = openai("gpt-5.6", env(key));
      await expect(
        Effect.runPromise(Effect.scoped(createSession({ instructions: "", model, plugins: [] }))),
      ).rejects.toMatchObject({
        _tag: "TurnError",
        message: `Environment variable ${key} is not set or empty`,
      });
    } finally {
      if (previous !== undefined) process.env[key] = previous;
    }
  });

  test("surfaces backend model rejection after the request without preflight", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests += 1;
        return Response.json({ error: { message: "model not found" } }, { status: 404 });
      },
    });
    try {
      await withKey(async () => {
        const model = openai("future-private-model", env(key), {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
        });
        const exit = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* createSession({
                instructions: "",
                model,
                plugins: [],
              });
              return yield* Effect.exit(Stream.runDrain(session.prompt("Hi")));
            }),
          ),
        );
        expect(Cause.squash(Exit.isFailure(exit) ? exit.cause : Cause.empty)).toMatchObject({
          _tag: "TurnError",
          cause: { reason: { _tag: "InvalidRequestError" } },
        });
      });
      expect(requests).toBe(1);
    } finally {
      void server.stop(true);
    }
  });

  test("maps Responses function calls through the Core Tool loop", async () => {
    let calls = 0;
    let followUp: { readonly input?: ReadonlyArray<Record<string, unknown>> } = {};
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as {
          readonly tools?: ReadonlyArray<unknown>;
          readonly input?: ReadonlyArray<Record<string, unknown>>;
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
      },
    });
    try {
      await withKey(async () => {
        const echo = Tool.make("echo", {
          parameters: Schema.Struct({ text: Schema.String }),
          success: Schema.String,
        });
        const definition: AgentDefinition = {
          instructions: "",
          model: openai("gpt-5.6", env(key), {
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
          }),
          plugins: [
            {
              name: "echo",
              toolkit: Toolkit.make(echo),
              handlers: {
                echo: (params) => Effect.succeed((params as { text: string }).text),
              },
            },
          ],
        };
        const events = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* createSession(definition);
              return yield* Stream.runCollect(session.prompt("Hi"));
            }),
          ),
        );
        expect([...events]).toEqual([
          { type: "tool-call", id: "call-1", name: "echo" },
          {
            type: "tool-result",
            id: "call-1",
            name: "echo",
            result: "hello",
            isFailure: false,
          },
          { type: "model-output", text: "done" },
          { type: "response-complete" },
        ]);
      });
      expect(calls).toBe(2);
      expect(followUp.input).toContainEqual({
        type: "function_call_output",
        call_id: "call-1",
        output: '"hello"',
      });
    } finally {
      void server.stop(true);
    }
  });
});
