import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import {
  type AgentDefinition,
  createSession,
  makeProvider,
  type TranscriptEventRecord,
  TranscriptEventRecordSchema,
  TranscriptNotFound,
  type TranscriptStore,
} from "../../src/index.js";
import { makeDeterministicProvider } from "../support/provider.js";

const makeRecordingStore = (
  records: Array<TranscriptEventRecord>,
  onAppend: Effect.Effect<void> = Effect.void,
): TranscriptStore => ({
  save: () => Effect.void,
  load: (id) => Effect.fail(new TranscriptNotFound({ id })),
  list: () => Effect.succeed([]),
  appendEvent: (record) =>
    Effect.sync(() => void records.push(record)).pipe(Effect.andThen(onAppend)),
});

describe("Session event log", () => {
  it.effect("appends every emitted event incrementally with one monotonic Session sequence", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicProvider("hello");
      const records: Array<TranscriptEventRecord> = [];
      const session = yield* createSession(
        {
          providers: [fixture.provider],
          model: "test/default",
          extensions: [],
        },
        { store: makeRecordingStore(records) },
      );

      yield* Stream.runDrain(session.prompt("first"));
      yield* Stream.runDrain(session.prompt("second"));

      expect(records.map(({ seq }) => seq)).toEqual([0, 1, 2, 3]);
      expect(new Set(records.map(({ sessionId }) => sessionId)).size).toBe(1);
      expect(records.every(({ transcriptId }) => transcriptId === session.transcript().id)).toBe(
        true,
      );
      expect(records.map(({ event }) => event.type)).toEqual([
        "model-output",
        "response-complete",
        "model-output",
        "response-complete",
      ]);
    }),
  );

  it.effect("decodes an interrupted Turn as an expected incomplete tail", () =>
    Effect.gen(function* () {
      const appended = yield* Deferred.make<void>();
      const records: Array<TranscriptEventRecord> = [];
      const provider = makeProvider("test", [] as const, undefined, () =>
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.succeed([]),
            streamText: () =>
              Stream.concat(
                Stream.succeed({ type: "text-delta", id: "partial", delta: "partial" }),
                Stream.never,
              ),
          }),
        ),
      );
      const session = yield* createSession(
        { providers: [provider], model: "test/default", extensions: [] },
        {
          store: makeRecordingStore(
            records,
            Deferred.succeed(appended, undefined).pipe(Effect.asVoid),
          ),
        },
      );
      const turn = yield* Effect.forkChild(Stream.runDrain(session.prompt("Hi")));

      yield* Deferred.await(appended);
      yield* Fiber.interrupt(turn);
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(TranscriptEventRecordSchema))(
        JSON.parse(JSON.stringify(records)),
      );

      expect(decoded.map(({ event }) => event.type)).toEqual(["model-output"]);
      expect(decoded.some(({ event }) => event.type === "response-complete")).toBe(false);
    }),
  );

  it.effect("records Approval requests and outcomes without resolution closures", () =>
    Effect.gen(function* () {
      let calls = 0;
      const provider = makeProvider("test", [] as const, undefined, () =>
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () => Effect.succeed([]),
            streamText: () => {
              calls += 1;
              return Stream.succeed(
                calls === 1
                  ? {
                      type: "tool-call" as const,
                      id: "call-1",
                      name: "dangerous",
                      params: { action: "delete" },
                    }
                  : { type: "text-delta" as const, id: "done", delta: "continued" },
              );
            },
          }),
        ),
      );
      const dangerous = Tool.make("dangerous", {
        parameters: Schema.Struct({ action: Schema.String }),
        success: Schema.String,
        needsApproval: true,
      });
      const definition: AgentDefinition = {
        providers: [provider],
        model: "test/default",
        extensions: [
          {
            name: "dangerous",
            toolkit: Toolkit.make(dangerous),
            handlers: { dangerous: () => Effect.succeed("executed") },
          },
        ],
      };
      const records: Array<TranscriptEventRecord> = [];
      const session = yield* createSession(definition, { store: makeRecordingStore(records) });

      yield* Stream.runForEach(session.prompt("Hi"), (event) =>
        event.type === "approval-required" ? event.deny("not allowed") : Effect.void,
      );
      const encoded = JSON.parse(
        JSON.stringify(
          yield* Schema.encodeEffect(Schema.Array(TranscriptEventRecordSchema))(records),
        ),
      );
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(TranscriptEventRecordSchema))(
        encoded,
      );

      expect(decoded.map(({ event }) => event.type)).toEqual([
        "tool-call",
        "approval-required",
        "approval-resolved",
        "tool-result",
        "model-output",
        "response-complete",
      ]);
      expect(decoded[1]!.event).toEqual({
        type: "approval-required",
        approvalId: expect.any(String),
        toolCallId: "call-1",
        name: "dangerous",
        params: { action: "delete" },
      });
      const approvalRequest = decoded[1]!.event;
      expect(approvalRequest.type).toBe("approval-required");
      if (approvalRequest.type !== "approval-required") return;
      expect(decoded[2]!.event).toEqual({
        type: "approval-resolved",
        approvalId: approvalRequest.approvalId,
        toolCallId: "call-1",
        approved: false,
        reason: "not allowed",
      });
      expect(Object.keys(encoded[1].event)).not.toContain("approve");
      expect(Object.keys(encoded[1].event)).not.toContain("deny");
    }),
  );
});
