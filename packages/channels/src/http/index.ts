/**
 * Generic HTTP Channel: `POST /conversations/:id/turns` streams one Turn as Server-Sent Events.
 *
 * @module @mitome/channels/http
 */

import {
  createSession,
  type ApprovalResolutionError,
  type ChannelHost,
  type ChannelHostContext,
  type RouteKey,
  type Routes,
  type StoreError,
  type Transcript,
  type TurnEvent,
} from "@mitome/core";
import { Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { createRouteLock } from "../shared/route-lock.js";
import type { Authenticator } from "./auth.js";
import { encodeFrame, toWireEvent, type WireTurnEvent } from "./sse.js";

export { bearer } from "./auth.js";
export type { Authenticator } from "./auth.js";
export type { TurnFrame, WireTurnEvent } from "./sse.js";

/** Options for `http()`. */
export interface HttpOptions {
  /** Channel Host name, unique in its Mitome Definition; `mitome serve` mounts the Channel under `/<name>`. Defaults to `"http"`. */
  readonly name?: string | undefined;
  /** Resolves the principal of every request before anything else runs; see `bearer`. */
  readonly auth: Authenticator;
  /** Route store mapping `(name, principal, conversation)` to the latest Transcript, such as `fileRoutes()`. */
  readonly routes: Routes;
  /**
   * `"deny"` (default) answers every pending Approval with a stable denial the Model sees.
   * `"interactive"` keeps it pending for `POST /turns/:turnId/approvals/:approvalId` and denies it
   * after `approvalTimeoutMs`. Unflagged and Agent-allowed Tool calls run in both modes; there is
   * no auto-approve mode, run unattended through the Agent's `approvals.allow`.
   */
  readonly approvals?: "deny" | "interactive" | undefined;
  /** How long an `"interactive"` Approval may stay unanswered before it is denied. Defaults to 5 minutes. */
  readonly approvalTimeoutMs?: number | undefined;
}

const TurnRequestBody = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.String,
    model: Schema.optional(Schema.TemplateLiteral([Schema.String, "/", Schema.String])),
  }),
);
const DecisionBody = Schema.fromJsonString(
  Schema.Struct({
    decision: Schema.Literals(["approve", "deny"]),
    reason: Schema.optional(Schema.String),
  }),
);
const decodeTurnRequest = Schema.decodeUnknownOption(TurnRequestBody);
const decodeDecision = Schema.decodeUnknownOption(DecisionBody);

const turnPath = /^\/conversations\/([^/]+)\/turns$/;
const approvalPath = /^\/turns\/([^/]+)\/approvals\/([^/]+)$/;

const decodeSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

const readBody = (request: Request): Promise<string | undefined> =>
  request.text().then(
    (body) => body,
    () => undefined,
  );

const text = (status: number, body: string): Response => new Response(body, { status });
const notFound = (): Response => text(404, "Not Found");
const methodNotAllowed = (): Response =>
  new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
const malformedBody = (): Response => text(400, "Malformed request body");

interface PendingApproval {
  readonly turnId: string;
  readonly approvalId: string;
  readonly principal: string;
  readonly conversation: string;
  readonly approve: () => Effect.Effect<void, ApprovalResolutionError>;
  readonly deny: (reason?: string) => Effect.Effect<void, ApprovalResolutionError>;
}

type ApprovalRequiredEvent = Extract<TurnEvent, { readonly type: "approval-required" }>;

/**
 * Creates the HTTP Channel Host. `handle` answers `POST /conversations/:id/turns` with a
 * `text/event-stream` of `TurnFrame`s for one Turn and, with `approvals: "interactive"`,
 * `POST /turns/:turnId/approvals/:approvalId` with an Approval decision. Authentication runs
 * first; the Route key is `(name, principal, conversation)`, so a conversation id is never
 * authorization. One Turn runs per Route at a time (`409` on overlap), a client disconnect
 * interrupts the Turn and closes its Session, and after the stream started a failure is one final
 * `error` frame rather than a changed status. Pending Approvals live in memory for the Turn only.
 */
export const http = (options: HttpOptions): ChannelHost => {
  const name = options.name ?? "http";
  const interactive = options.approvals === "interactive";
  const approvalTimeoutMs = options.approvalTimeoutMs ?? 300_000;
  const withLock = createRouteLock();
  const pending = new Map<string, Map<string, PendingApproval>>();
  const encoder = new TextEncoder();

  // Stable, Model-visible text; it never carries exception details.
  const defaultDenial = `Approval denied: the http Channel "${name}" does not resolve Approvals (set approvals: "interactive" or list the Tool under approvals.allow)`;
  const timeoutDenial = `Approval denied: the http Channel "${name}" received no decision before the Approval timed out`;

  const takePending = (turnId: string, approvalId: string): PendingApproval | undefined => {
    const byTurn = pending.get(turnId);
    const entry = byTurn?.get(approvalId);
    if (byTurn === undefined || entry === undefined) return undefined;
    byTurn.delete(approvalId);
    if (byTurn.size === 0) pending.delete(turnId);
    return entry;
  };

  const registerPending = (
    entry: PendingApproval,
    sessionScope: Scope.Scope,
  ): Effect.Effect<void> => {
    const byTurn = pending.get(entry.turnId) ?? new Map<string, PendingApproval>();
    byTurn.set(entry.approvalId, entry);
    pending.set(entry.turnId, byTurn);
    // The timer dies with the Session scope, so an interrupted Turn leaves no timer behind.
    return Effect.suspend(() => {
      const timedOut = takePending(entry.turnId, entry.approvalId);
      return timedOut === undefined ? Effect.void : Effect.ignore(timedOut.deny(timeoutDenial));
    }).pipe(Effect.delay(approvalTimeoutMs), Effect.forkIn(sessionScope), Effect.asVoid);
  };

  const loadTranscript = (
    context: ChannelHostContext,
    key: RouteKey,
  ): Effect.Effect<Transcript | undefined, StoreError> =>
    Effect.gen(function* () {
      if (context.transcripts === undefined) return undefined;
      const transcriptId = yield* options.routes.get(key);
      if (transcriptId === undefined) return undefined;
      // A stale Route names a Transcript that no longer loads; the conversation starts fresh.
      return yield* context.transcripts
        .load(transcriptId)
        .pipe(Effect.catchTag("TranscriptNotFound", () => Effect.succeed(undefined)));
    });

  const runTurn = async (
    context: ChannelHostContext,
    request: Request,
    key: RouteKey,
    body: typeof TurnRequestBody.Type,
  ): Promise<Response> => {
    const turnId = crypto.randomUUID();
    const ready = Promise.withResolvers<void>();
    const opened = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    let closed = false;

    // Resolves with the status to answer when the Turn never reached its headers.
    const program: Effect.Effect<number> = withLock(
      key,
      Effect.scoped(
        Effect.gen(function* () {
          const sessionScope = yield* Effect.scope;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              pending.delete(turnId);
            }),
          );
          const transcript = yield* loadTranscript(context, key);
          const session = yield* createSession(context.agent, {
            transcripts: context.transcripts,
            transcript,
          });
          const committedMessages = session.history().length;
          ready.resolve();
          const controller = yield* Effect.promise(() => opened.promise);
          const send = (event: WireTurnEvent) =>
            Effect.sync(() => {
              if (closed) return;
              controller.enqueue(encoder.encode(encodeFrame({ v: 1, turnId, event })));
            });
          const advanceRoute = options.routes.set(key, session.transcript().id);
          const resolveApproval = (event: ApprovalRequiredEvent): Effect.Effect<void> =>
            interactive
              ? registerPending(
                  {
                    turnId,
                    approvalId: event.approvalId,
                    principal: key.principal,
                    conversation: key.conversation,
                    approve: event.approve,
                    deny: event.deny,
                  },
                  sessionScope,
                )
              : Effect.ignore(event.deny(defaultDenial));

          yield* session
            .runTurn(body.message, body.model === undefined ? undefined : { model: body.model })
            .pipe(
              Stream.mapEffect((event) =>
                Effect.gen(function* () {
                  if (event.type === "approval-required") yield* resolveApproval(event);
                  // The Route advances before the client learns the Turn completed.
                  if (event.type === "response-complete") yield* advanceRoute;
                  return toWireEvent(event);
                }),
              ),
              Stream.runForEach(send),
              Effect.catchTags({
                TurnError: (error) => send({ type: "error", message: error.message }),
                SessionBusyError: (error) => send({ type: "error", message: error.message }),
                SessionReleasedError: (error) => send({ type: "error", message: error.message }),
                // The Turn may already be committed when its final event record fails to append.
                StoreError: () =>
                  (session.history().length > committedMessages
                    ? Effect.ignore(advanceRoute)
                    : Effect.void
                  ).pipe(
                    Effect.andThen(send({ type: "error", message: "Transcript store failed" })),
                  ),
              }),
              Effect.catchDefect(() => send({ type: "error", message: "Turn failed" })),
            );
          return 200;
        }),
      ),
    ).pipe(
      Effect.catchTag("RouteBusyError", () => Effect.succeed(409)),
      Effect.orElseSucceed(() => 500),
      Effect.catchDefect(() => Effect.succeed(500)),
    );

    const fiber = Effect.runFork(program);
    if (request.signal.aborted) fiber.interruptUnsafe();
    request.signal.addEventListener("abort", () => fiber.interruptUnsafe(), { once: true });
    const exit = await Promise.race([
      ready.promise.then(() => undefined),
      new Promise<Exit.Exit<number>>((resolve) => fiber.addObserver(resolve)),
    ]);
    if (exit !== undefined) {
      const status = Exit.isSuccess(exit) ? exit.value : 500;
      return status === 409
        ? text(409, "Conversation is busy with another Turn")
        : text(500, "Turn could not start");
    }

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => opened.resolve(controller),
      cancel: () => {
        closed = true;
        return Effect.runPromise(Fiber.interrupt(fiber));
      },
    });
    fiber.addObserver(() => {
      if (closed) return;
      closed = true;
      void opened.promise.then((controller) => controller.close());
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  };

  const decide = async (
    request: Request,
    principal: string,
    turnId: string,
    approvalId: string,
  ): Promise<Response> => {
    const raw = await readBody(request);
    const body = raw === undefined ? Option.none() : decodeDecision(raw);
    if (Option.isNone(body)) return malformedBody();
    const entry = pending.get(turnId)?.get(approvalId);
    if (entry === undefined) return notFound();
    // IDs are correlation, not authorization: only the Turn's own principal may decide.
    if (entry.principal !== principal) return text(403, "Forbidden");
    takePending(turnId, approvalId);
    const decision =
      body.value.decision === "approve"
        ? entry.approve()
        : entry.deny(body.value.reason ?? "Approval denied by the user.");
    const exit = await Effect.runPromiseExit(decision);
    // A decision that no longer applies (the Turn ended meanwhile) is stale and never re-executes.
    return Exit.isSuccess(exit) ? new Response(null, { status: 204 }) : notFound();
  };

  return {
    kind: "channel",
    name,
    handle: async (context, request) => {
      let principal: string | undefined;
      try {
        principal = await options.auth(request);
      } catch {
        return text(500, "Authentication failed");
      }
      if (principal === undefined) return text(401, "Unauthorized");

      const { pathname } = new URL(request.url);
      const turn = turnPath.exec(pathname);
      if (turn !== null) {
        if (request.method !== "POST") return methodNotAllowed();
        const conversation = decodeSegment(turn[1]!);
        if (conversation === undefined) return notFound();
        const raw = await readBody(request);
        const body = raw === undefined ? Option.none() : decodeTurnRequest(raw);
        if (Option.isNone(body)) return malformedBody();
        return runTurn(context, request, { channel: name, principal, conversation }, body.value);
      }
      const approval = interactive ? approvalPath.exec(pathname) : null;
      if (approval !== null) {
        if (request.method !== "POST") return methodNotAllowed();
        const turnId = decodeSegment(approval[1]!);
        const approvalId = decodeSegment(approval[2]!);
        if (turnId === undefined || approvalId === undefined) return notFound();
        return decide(request, principal, turnId, approvalId);
      }
      return notFound();
    },
  };
};
