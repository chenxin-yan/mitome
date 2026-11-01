import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, Prompt, type Response as AiResponse, Tool, Toolkit } from "effect/ai";
import { credentialDescriptor, providerModel } from "@mitome/core";
import { fakeFetch, runWithKey, sse } from "../support.js";
import { openaiCompatible } from "../../src/openai-compatible/index.js";

type Json = typeof Schema.Json.Type;
type JsonObject = { readonly [key: string]: Json };
interface ToolMessage {
  readonly role: string;
  readonly tool_call_id?: string;
  readonly content?: Json;
}
interface FollowUpRequest {
  readonly messages?: ReadonlyArray<ToolMessage>;
}

const key = "MITOME_OPENAI_COMPATIBLE_TEST_KEY";
const run = runWithKey(key);
const chunk = (delta: JsonObject, finishReason: string | null = null) => ({
  id: "chatcmpl-test",
  model: "gpt-4o-mini",
  created: 1,
  choices: [{ index: 0, finish_reason: finishReason, delta }],
});

const textDeltas = (parts: ReadonlyArray<AiResponse.AnyPart>) =>
  parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []));

describe("openaiCompatible", () => {
  it("exposes its credential descriptor without provisioning a Model", () => {
    expect(
      credentialDescriptor(
        openaiCompatible({
          id: "compatible",
          baseUrl: "http://localhost:1",
          apiKeyEnv: "MITOME_TEST_API_KEY",
        }),
      ),
    ).toBe("MITOME_TEST_API_KEY");
    expect(
      credentialDescriptor(openaiCompatible({ id: "local", baseUrl: "http://localhost:1" })),
    ).toBeUndefined();
  });

  it("passes known and arbitrary model ids unchanged and streams text incrementally", async () => {
    const requests: Array<{
      readonly model: string;
      readonly stream: boolean;
      readonly authorization: string | null;
    }> = [];
    const { promise: secondReleased, resolve: releaseSecond } = Promise.withResolvers<void>();
    const { promise: firstChunkSent, resolve: firstChunk } = Promise.withResolvers<void>();
    const fetch = fakeFetch(async (request) => {
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
      // SAFETY: this controlled client request is emitted from the compatible request schema.
      const body = (await request.json()) as { model: string; stream: boolean };
      requests.push({
        model: body.model,
        stream: body.stream,
        authorization: request.headers.get("authorization"),
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const enqueue = (value: string) => controller.enqueue(new TextEncoder().encode(value));
            enqueue(sse(chunk({ content: "hel" })));
            firstChunk();
            await secondReleased;
            enqueue(sse(chunk({ content: "lo" }, "stop")));
            enqueue(sse("[DONE]"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    const provider = openaiCompatible({
      id: "compatible",
      apiKeyEnv: key,
      // Trailing slash pins baseUrl normalization.
      baseUrl: "https://test.invalid/v1/",
    });
    const parts: Array<AiResponse.AnyPart> = [];
    const { promise: output, resolve: firstOutput } = Promise.withResolvers<void>();
    const generation = run(
      LanguageModel.streamText({ prompt: "Hi" }).pipe(
        Stream.runForEach((part) =>
          Effect.sync(() => {
            parts.push(part);
            if (part.type === "text-delta") firstOutput();
          }),
        ),
        Effect.provide(providerModel(provider, "gpt-4o-mini")),
      ),
      fetch,
    );
    await firstChunkSent;
    await output;
    expect(textDeltas(parts)).toEqual(["hel"]);
    releaseSecond();
    await generation;
    expect(textDeltas(parts)).toEqual(["hel", "lo"]);
    expect(parts.at(-1)).toMatchObject({ type: "finish", reason: "stop" });

    await run(
      Stream.runDrain(LanguageModel.streamText({ prompt: "Hi" })).pipe(
        Effect.provide(providerModel(provider, "ft:private-model")),
      ),
      fetch,
    );
    expect(requests).toEqual([
      { model: "gpt-4o-mini", stream: true, authorization: "Bearer synthetic-key" },
      { model: "ft:private-model", stream: true, authorization: "Bearer synthetic-key" },
    ]);
  });

  it("surfaces backend model rejection after the request without preflight", async () => {
    let requests = 0;
    const fetch = fakeFetch(async () => {
      requests += 1;
      return Response.json({ error: { message: "model not found" } }, { status: 404 });
    });
    const provider = openaiCompatible({
      id: "compatible",
      apiKeyEnv: key,
      baseUrl: "https://test.invalid/v1",
    });
    const error = await run(
      Effect.flip(
        Stream.runDrain(LanguageModel.streamText({ prompt: "Hi" })).pipe(
          Effect.provide(providerModel(provider, "future-private-model")),
        ),
      ),
      fetch,
    );
    expect(error).toMatchObject({ _tag: "AiError", reason: { _tag: "InvalidRequestError" } });
    expect(requests).toBe(1);
  });

  it("maps tool calls and their results across generations", async () => {
    let calls = 0;
    let followUp: FollowUpRequest = {};
    const fetch = fakeFetch(async (request) => {
      // SAFETY: this controlled client request is emitted from the compatible request schema.
      const body = (await request.json()) as {
        readonly tools?: ReadonlyArray<Json>;
        readonly messages?: ReadonlyArray<ToolMessage>;
      };
      calls += 1;
      if (calls === 1) {
        expect(body.tools).toHaveLength(1);
        return new Response(
          sse(
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "echo", arguments: '{"text":' },
                },
              ],
            }),
          ) +
            sse(
              chunk(
                { tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] },
                "tool_calls",
              ),
            ) +
            sse("[DONE]"),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      followUp = body;
      return new Response(sse(chunk({ content: "done" }, "stop")) + sse("[DONE]"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const echo = Tool.make("echo", {
      parameters: Schema.Struct({ text: Schema.String }),
      success: Schema.String,
    });
    const provider = openaiCompatible({
      id: "compatible",
      apiKeyEnv: key,
      baseUrl: "https://test.invalid/v1",
    });
    const Echo = Toolkit.make(echo);
    const { first, second } = await run(
      Effect.gen(function* () {
        const prompt = Prompt.make("Hi");
        const first = [
          ...(yield* Stream.runCollect(LanguageModel.streamText({ prompt, toolkit: Echo }))),
        ];
        const second = yield* Stream.runCollect(
          LanguageModel.streamText({
            prompt: Prompt.concat(prompt, Prompt.fromResponseParts(first)),
          }),
        );
        return { first, second: [...second] };
      }).pipe(
        Effect.provide(
          Layer.merge(
            Echo.toLayer({ echo: ({ text }) => Effect.succeed(text) }),
            providerModel(provider, "gpt-4o-mini"),
          ),
        ),
      ),
      fetch,
    );
    expect(
      first.filter((part) => part.type === "tool-call" || part.type === "tool-result"),
    ).toMatchObject([
      { type: "tool-call", id: "call-1", name: "echo", params: { text: "hello" } },
      { type: "tool-result", id: "call-1", name: "echo", result: "hello", isFailure: false },
    ]);
    expect(textDeltas(second)).toEqual(["done"]);
    expect(second.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
    expect(calls).toBe(2);
    // The follow-up request must carry the tool result attributed to the original call.
    const toolMessage = followUp.messages?.find((message) => message.role === "tool");
    expect(toolMessage).toMatchObject({ tool_call_id: "call-1" });
    expect(JSON.stringify(toolMessage?.content)).toContain("hello");
  });
});
