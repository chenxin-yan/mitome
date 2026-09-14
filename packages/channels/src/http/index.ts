/**
 * Generic HTTP Channel: `POST /conversations/:id/turns` streams one Turn as Server-Sent Events.
 *
 * @module @mitome/channels/http
 */

import {
  createSession,
  type ChannelHost,
  type ChannelHostContext,
  type RouteKey,
  type Routes,
  type TurnEvent,
} from "@mitome/core";
import { Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import { createPendingApprovals } from "../shared/pending-approvals.js";
import { createRouteLock } from "../shared/route-lock.js";
import { loadRouteTranscript } from "../shared/route-transcript.js";
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
    // Core's Qualified Model id: a non-empty Provider id, one slash, a non-empty Model id. The
    // template literal alone also accepts "/" and "test/", so the pattern narrows it.
    model: Schema.optional(
      Schema.TemplateLiteral([Schema.String, "/", Schema.String]).check(
        Schema.isPattern(/^[^/]+\/.+$/),
      ),
    ),
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

// `handle` may run on a Node listener with no body cap, so the Channel bounds what it buffers.
const MAX_BODY_BYTES = 1_048_576;

/** The body as text, or undefined once it exceeds `limit`; an unreadable body counts as empty. */
const readBody = async (request: Request, limit: number): Promise<string | undefined> => {
  if (Number(request.headers.get("content-length")) > limit) return undefined;
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return body + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        // Not awaited: the request was cloned for the Authenticator, and a tee branch's cancel
        // settles only once the other branch is cancelled as well.
        reader.cancel().catch(() => undefined);
        return undefined;
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return "";
  }
};

const text = (status: number, body: string): Response => new Response(body, { status });
const notFound = (): Response => text(404, "Not Found");
const methodNotAllowed = (): Response =>
  new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
const malformedBody = (): Response => text(400, "Malformed request body");
const payloadTooLarge = (): Response => text(413, "Payload Too Large");

// Both ids are opaque strings, so no separator is safe; the array encoding cannot collide.
const pendingId = (turnId: string, approvalId: string): string =>
  JSON.stringify([turnId, approvalId]);

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
  const encoder = new TextEncoder();

  // Stable, Model-visible text; it never carries exception details.
  const defaultDenial = `Approval denied: the http Channel "${name}" does not resolve Approvals (set approvals: "interactive" or list the Tool under approvals.allow)`;
  const pending = createPendingApprovals(
    approvalTimeoutMs,
    `Approval denied: the http Channel "${name}" received no decision before the Approval timed out`,
  );

  const runTurn = async (
    context: ChannelHostContext,
    request: Request,
    key: RouteKey,
    body: typeof TurnRequestBody.Type,
  ): Promise<Response> => {
    const turnId = crypto.randomUUID();
    const ready = Promise.withResolvers<void>();
    const opened = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    // Resolved by every `pull`, so a producer waiting on a slow reader wakes when it reads again.
    let pulled = Promise.withResolvers<void>();
    let closed = false;

    // Resolves with the status to answer when the Turn never reached its headers.
    const program: Effect.Effect<number> = withLock(
      key,
      Effect.scoped(
        Effect.gen(function* () {
          const sessionScope = yield* Effect.scope;
          const transcript = yield* loadRouteTranscript(options.routes, context, key);
          const session = yield* createSession(context.agent, {
            transcripts: context.transcripts,
            transcript,
          });
          const committedMessages = session.history().length;
          ready.resolve();
          const controller = yield* Effect.promise(() => opened.promise);
          const send = (event: WireTurnEvent) =>
            Effect.promise(async () => {
              const frame = encoder.encode(encodeFrame({ v: 1, turnId, event }));
              // A client that stops reading stops the Turn here instead of growing the queue.
              while (!closed && (controller.desiredSize ?? 0) <= 0) await pulled.promise;
              if (!closed) controller.enqueue(frame);
            });
          // Without a Transcript store nothing is saved, so a Route would name a Transcript that never existed.
          const advanceRoute =
            context.transcripts === undefined
              ? Effect.void
              : options.routes.set(key, session.transcript().id);
          const resolveApproval = (event: ApprovalRequiredEvent): Effect.Effect<void> =>
            interactive
              ? pending.register(
                  pendingId(turnId, event.approvalId),
                  { key, approve: event.approve, deny: event.deny },
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
              // Fixed public text: a TurnError may carry a Provider's own message, and the caller
              // is not the operator.
              Effect.catchTags({
                TurnError: () => send({ type: "error", message: "Turn failed" }),
                SessionBusyError: () => send({ type: "error", message: "Session busy" }),
                SessionReleasedError: () => send({ type: "error", message: "Session released" }),
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
      pull: () => {
        pulled.resolve();
        pulled = Promise.withResolvers();
      },
      cancel: () => {
        closed = true;
        pulled.resolve();
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
    const raw = await readBody(request, MAX_BODY_BYTES);
    if (raw === undefined) return payloadTooLarge();
    const body = decodeDecision(raw);
    if (Option.isNone(body)) return malformedBody();
    const id = pendingId(turnId, approvalId);
    const entry = pending.peek(id);
    if (entry === undefined) return notFound();
    // IDs are correlation, not authorization: only the Turn's own principal may decide.
    if (entry.key.principal !== principal) return text(403, "Forbidden");
    pending.take(id);
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
        // A clone keeps the body readable here when the Authenticator verifies a signed payload.
        principal = await options.auth(request.clone());
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
        const raw = await readBody(request, MAX_BODY_BYTES);
        if (raw === undefined) return payloadTooLarge();
        const body = decodeTurnRequest(raw);
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
