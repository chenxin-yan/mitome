import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import {
  type AgentDefinition,
  createSession,
  defineExtension,
  makeTranscript,
  promptFromTranscript,
  TranscriptSchema,
} from "../src/index.js";
import { makeTestProvider } from "./support/provider.js";

const encodePrompt = Schema.encodeSync(Prompt.Prompt);

describe("TranscriptSchema", () => {
  it.effect("round-trips committed Tool and reasoning history from a Session", () =>
    Effect.gen(function* () {
      let calls = 0;
      const metadata = { openai: { itemId: "reasoning-1", encryptedContent: "encrypted" } };
      const provider = makeTestProvider((options) => {
        calls += 1;
        if (calls === 2) {
          return Stream.succeed(
            Response.makePart("text", {
              text: "done",
              metadata: { openai: { responseId: "response-1" } },
            }),
          );
        }
        const call = Response.makePart("tool-call", {
          id: "call-1",
          name: "echo",
          params: { text: "hello" },
          providerExecuted: false,
          metadata: { openai: { callId: "provider-call-1" } },
        });
        return Stream.concat(
          Stream.fromIterable([
            Response.makePart("reasoning-start", { id: "reasoning-1", metadata }),
            Response.makePart("reasoning-delta", {
              id: "reasoning-1",
              delta: "thinking",
            }),
            Response.makePart("reasoning-end", { id: "reasoning-1", metadata }),
            call,
          ]),
          Stream.unwrap(
            options.toolkit!.handle("echo", call.params).pipe(
              Effect.map((results) =>
                Stream.map(results, (result) =>
                  Response.makePart("tool-result", {
                    id: call.id,
                    name: call.name,
                    providerExecuted: false,
                    metadata: { openai: { resultId: "result-1" } },
                    ...result,
                  }),
                ),
              ),
            ),
          ),
        );
      });
      const echo = Tool.make("echo", {
        parameters: Schema.Struct({ text: Schema.String }),
        success: Schema.Struct({ echoed: Schema.String }),
      });
      const definition: AgentDefinition = {
        providers: [provider],
        model: "test/default",
        extensions: [
          defineExtension({
            name: "echo",
            instructions: "Be concise.",
            toolkit: Toolkit.make(echo),
            handlers: { echo: ({ text }) => Effect.succeed({ echoed: text }) },
          }),
        ],
      };
      const session = yield* createSession(definition);
      yield* Stream.runDrain(session.prompt("Hi"));

      const originalPrompt = Prompt.fromMessages(session.history());
      const transcript = makeTranscript({
        id: "transcript-1",
        parentTranscriptId: "transcript-parent",
        messages: session.history(),
      });
      const encoded = yield* Schema.encodeEffect(TranscriptSchema)(transcript);
      const decoded = yield* Schema.decodeUnknownEffect(TranscriptSchema)(
        JSON.parse(JSON.stringify(encoded)),
      );

      expect(yield* Schema.encodeEffect(TranscriptSchema)(decoded)).toStrictEqual(encoded);
      expect(encodePrompt(promptFromTranscript(decoded))).toStrictEqual(
        encodePrompt(originalPrompt),
      );
      expect(encoded).toMatchObject({
        schemaVersion: 1,
        id: "transcript-1",
        parentTranscriptId: "transcript-parent",
      });
      expect(JSON.stringify(encoded)).toContain("encrypted");
      expect(JSON.stringify(encoded)).toContain("provider-call-1");
      expect(JSON.stringify(encoded)).toContain("response-1");
      expect(JSON.stringify(encoded)).toContain('"echoed":"hello"');
    }),
  );

  it("preserves multiple text parts and their Provider options", () => {
    const prompt = Prompt.make([
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.textPart({ text: "first", options: { test: { responseId: "response-1" } } }),
          Prompt.textPart({ text: "second", options: { test: { responseId: "response-2" } } }),
        ],
      }),
    ]);

    const encoded = Schema.encodeSync(TranscriptSchema)(
      makeTranscript({ id: "transcript-text-parts", messages: prompt.content }),
    );
    const decoded = Schema.decodeSync(TranscriptSchema)(encoded);

    expect(promptFromTranscript(decoded).content[0]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "first", options: { test: { responseId: "response-1" } } },
        { type: "text", text: "second", options: { test: { responseId: "response-2" } } },
      ],
    });
  });

  it("preserves every Prompt content part and Provider option", () => {
    const prompt = Prompt.fromMessages([
      Prompt.makeMessage("user", {
        options: { test: { message: true } },
        content: [
          Prompt.textPart({ text: "files" }),
          Prompt.filePart({ mediaType: "text/plain", data: "inline" }),
          Prompt.filePart({ mediaType: "application/octet-stream", data: new Uint8Array([1, 2]) }),
          Prompt.filePart({ mediaType: "text/plain", data: new URL("https://example.com/a") }),
        ],
      }),
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.reasoningPart({ text: "thinking", options: { test: { part: true } } }),
          Prompt.toolCallPart({
            id: "call-1",
            name: "echo",
            params: { text: "hello" },
            providerExecuted: false,
          }),
          Prompt.toolResultPart({
            id: "provider-call-1",
            name: "search",
            isFailure: false,
            result: ["found"],
            providerExecuted: true,
          }),
          Prompt.toolApprovalRequestPart({ approvalId: "approval-1", toolCallId: "call-1" }),
        ],
      }),
      Prompt.makeMessage("tool", {
        content: [
          Prompt.toolResultPart({
            id: "call-1",
            name: "echo",
            isFailure: false,
            result: { echoed: "hello" },
            providerExecuted: false,
          }),
          Prompt.toolApprovalResponsePart({ approvalId: "approval-1", approved: true }),
        ],
      }),
    ]);

    const decoded = Schema.decodeSync(TranscriptSchema)(
      Schema.encodeSync(TranscriptSchema)(
        makeTranscript({ id: "transcript-parts", messages: prompt.content }),
      ),
    );

    expect(encodePrompt(promptFromTranscript(decoded))).toStrictEqual(encodePrompt(prompt));
  });

  it("rejects invalid persisted file URLs during Transcript decode", () => {
    expect(() =>
      Schema.decodeSync(TranscriptSchema)({
        schemaVersion: 1,
        id: "transcript-1",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "text/plain",
                data: { encoding: "url", value: "relative/path" },
              },
            ],
          },
        ],
      }),
    ).toThrow(/Expected an absolute URL/);
  });

  it("rejects malformed persisted base64 file data during Transcript decode", () => {
    expect(() =>
      Schema.decodeSync(TranscriptSchema)({
        schemaVersion: 1,
        id: "transcript-1",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "application/octet-stream",
                data: { encoding: "base64", value: "not base64!!" },
              },
            ],
          },
        ],
      }),
    ).toThrow(/Expected a base64 string/);
  });

  it("fails loudly on an unknown schema version", () => {
    expect(() =>
      Schema.decodeUnknownSync(TranscriptSchema)({
        schemaVersion: 2,
        id: "transcript-1",
        messages: [],
      }),
    ).toThrow(/Expected 1/);
  });

  it("rejects Tool payloads that are not JSON-compatible", () => {
    const prompt = Prompt.make([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            id: "call-1",
            name: "bad",
            params: { value: undefined },
            providerExecuted: false,
          },
        ],
      },
    ]);

    expect(() => makeTranscript({ id: "transcript-1", messages: prompt.content })).toThrow();
  });
});
