import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { LanguageModel, Response, Tool, Toolkit } from "effect/unstable/ai";
import {
  type AgentDefinition,
  createSession,
  makeProvider,
  type TranscriptEventRecord,
  TranscriptEventRecordSchema,
  TranscriptNotFound,
  type TranscriptStore,
} from "../../src/index.js";
import { makeDeterministicProvider, makeTestProvider } from "../support/provider.js";

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
        { transcripts: makeRecordingStore(records) },
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

  it.effect("does not reuse a sequence reserved by an interrupted append", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicProvider("hello");
      const appended = yield* Deferred.make<void>();
      const records: Array<TranscriptEventRecord> = [];
      let blockNextAppend = true;
      const store: TranscriptStore = {
        ...makeRecordingStore(records),
        appendEvent: (record) => {
          const block = blockNextAppend;
          blockNextAppend = false;
          return Effect.sync(() => void records.push(record)).pipe(
            Effect.andThen(
              block
                ? Deferred.succeed(appended, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.asVoid,
                  )
                : Effect.void,
            ),
          );
        },
      };
      const session = yield* createSession(
        {
          providers: [fixture.provider],
          model: "test/default",
          extensions: [],
        },
        { transcripts: store },
      );
      const interruptedTurn = yield* Effect.forkChild(Stream.runDrain(session.prompt("first")));

      yield* Deferred.await(appended);
      yield* Fiber.interrupt(interruptedTurn);
      yield* Stream.runDrain(session.prompt("second"));

      expect(records.map(({ seq }) => seq)).toEqual([0, 1, 2]);
    }),
  );

  it.effect("preserves the TranscriptStore method receiver when appending", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDeterministicProvider("hello");
      const records: Array<TranscriptEventRecord> = [];
      const store: TranscriptStore & { readonly records: Array<TranscriptEventRecord> } = {
        ...makeRecordingStore(records),
        records,
        appendEvent(record) {
          return Effect.sync(() => void this.records.push(record));
        },
      };
      const session = yield* createSession(
        {
          providers: [fixture.provider],
          model: "test/default",
          extensions: [],
        },
        { transcripts: store },
      );

      yield* Stream.runDrain(session.prompt("Hi"));

      expect(records).toHaveLength(2);
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
          transcripts: makeRecordingStore(
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

  it.effect("records encoded Tool results and maps Void to JSON null", () =>
    Effect.gen(function* () {
      const timestamp = new Date("2026-08-24T00:00:00.000Z");
      let calls = 0;
      const provider = makeTestProvider((options) => {
        calls += 1;
        if (calls === 3) {
          return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
        }
        const call = Response.makePart("tool-call", {
          id: `call-${calls}`,
          name: calls === 1 ? "notify" : "timestamp",
          params: {},
          providerExecuted: false,
        });
        return Stream.concat(
          Stream.succeed(call),
          Stream.unwrap(
            options.toolkit!.handle(call.name, {}).pipe(
              Effect.map((results) =>
                Stream.map(results, (result) =>
                  Response.makePart("tool-result", {
                    id: call.id,
                    name: call.name,
                    providerExecuted: false,
                    ...result,
                  }),
                ),
              ),
            ),
          ),
        );
      });
      const notify = Tool.make("notify", {
        parameters: Schema.Struct({}),
        success: Schema.Void,
      });
      const getTimestamp = Tool.make("timestamp", {
        parameters: Schema.Struct({}),
        success: Schema.DateFromString,
      });
      const records: Array<TranscriptEventRecord> = [];
      const session = yield* createSession(
        {
          providers: [provider],
          model: "test/default",
          extensions: [
            {
              name: "tools",
              toolkit: Toolkit.make(notify, getTimestamp),
              handlers: {
                notify: () => Effect.void,
                timestamp: () => Effect.succeed(timestamp),
              },
            },
          ],
        },
        { transcripts: makeRecordingStore(records) },
      );

      const events = yield* Stream.runCollect(session.prompt("Hi"));
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(TranscriptEventRecordSchema))(
        JSON.parse(JSON.stringify(records)),
      );

      expect([...events]).toContainEqual({
        type: "tool-result",
        id: "call-1",
        name: "notify",
        result: undefined,
        isFailure: false,
      });
      expect([...events]).toContainEqual({
        type: "tool-result",
        id: "call-2",
        name: "timestamp",
        result: timestamp,
        isFailure: false,
      });
      expect(
        decoded.filter(({ event }) => event.type === "tool-result").map(({ event }) => event),
      ).toEqual([
        {
          type: "tool-result",
          id: "call-1",
          name: "notify",
          result: null,
          isFailure: false,
        },
        {
          type: "tool-result",
          id: "call-2",
          name: "timestamp",
          result: timestamp.toISOString(),
          isFailure: false,
        },
      ]);
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
      const session = yield* createSession(definition, {
        transcripts: makeRecordingStore(records),
      });

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
