import { describe, expect, it } from "vitest";
import { type RouteKey, type Routes, memoryRoutes } from "@mitome/core";
import { Effect, Stream } from "effect";
import { AiError } from "effect/unstable/ai";
import { bearer, http } from "../../src/http/index.js";
import {
  agentWith,
  contextFor,
  decisionRequest,
  echoModel,
  frameReader,
  hangingModel,
  makeTestProvider,
  promptText,
  readFrames,
  toolModel,
  turnRequest,
} from "./support.js";

const auth = bearer({ "alice-token": "alice", "bob-token": "bob" });
const alice = (conversation: string): RouteKey => ({
  channel: "http",
  principal: "alice",
  conversation,
});

const countingRoutes = (): Routes & { readonly calls: () => number } => {
  const inner = memoryRoutes();
  let calls = 0;
  const count = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      calls += 1;
      return effect;
    });
  return {
    get: (key) => count(inner.get(key)),
    set: (key, id) => count(inner.set(key, id)),
    clear: (key) => count(inner.clear(key)),
    calls: () => calls,
  };
};

describe("http Channel Turns", () => {
  it("streams a new conversation as versioned SSE frames and resumes it on the next request", async () => {
    const model = echoModel("reply");
    const routes = memoryRoutes();
    const channel = http({ auth, routes });
    const context = contextFor(agentWith(model.provider));

    const first = await channel.handle!(context, turnRequest("chat-1", "alice-token"));
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/event-stream");
    const frames = await readFrames(first);
    expect(frames.map((frame) => frame.event.type)).toEqual(["model-output", "response-complete"]);
    expect(frames[0]!.event).toEqual({ type: "model-output", text: "reply" });
    expect(new Set(frames.map((frame) => frame.turnId)).size).toBe(1);
    expect(frames.map((frame) => frame.v)).toEqual([1, 1]);
    const transcriptId = await Effect.runPromise(routes.get(alice("chat-1")));
    expect(transcriptId).toEqual(expect.any(String));
    expect(model.released()).toBe(1);

    const second = await channel.handle!(
      context,
      turnRequest("chat-1", "alice-token", JSON.stringify({ message: "again" })),
    );
    const secondFrames = await readFrames(second);
    expect(secondFrames.at(-1)?.event.type).toBe("response-complete");
    expect(secondFrames[0]!.turnId).not.toBe(frames[0]!.turnId);
    expect(promptText(model.prompts[1]!)).toContain("hello");
    expect(promptText(model.prompts[1]!)).toContain("again");
    expect(await Effect.runPromise(routes.get(alice("chat-1")))).not.toBe(transcriptId);
  });

  it("starts fresh when the Route names a Transcript that no longer loads", async () => {
    const model = echoModel();
    const routes = memoryRoutes();
    await Effect.runPromise(routes.set(alice("chat-1"), "gone"));
    const channel = http({ auth, routes });
    const frames = await readFrames(
      await channel.handle!(
        contextFor(agentWith(model.provider)),
        turnRequest("chat-1", "alice-token"),
      ),
    );
    expect(frames.at(-1)?.event.type).toBe("response-complete");
    expect(await Effect.runPromise(routes.get(alice("chat-1")))).not.toBe("gone");
  });

  it("answers 401 before the Route store or the Provider is touched", async () => {
    const model = echoModel();
    const routes = countingRoutes();
    const channel = http({ auth, routes });
    const context = contextFor(agentWith(model.provider));

    expect((await channel.handle!(context, turnRequest("chat-1", "wrong"))).status).toBe(401);
    const noHeader = await channel.handle!(
      context,
      new Request("http://channel.test/conversations/chat-1/turns", { method: "POST", body: "{}" }),
    );
    expect(noHeader.status).toBe(401);
    expect(routes.calls()).toBe(0);
    expect(model.prompts).toHaveLength(0);
  });

  it("keeps two principals on distinct Routes for the same conversation id", async () => {
    const model = echoModel();
    const routes = memoryRoutes();
    const channel = http({ auth, routes });
    const context = contextFor(agentWith(model.provider));

    await readFrames(
      await channel.handle!(
        context,
        turnRequest("shared", "alice-token", JSON.stringify({ message: "alice secret" })),
      ),
    );
    await readFrames(
      await channel.handle!(
        context,
        turnRequest("shared", "bob-token", JSON.stringify({ message: "bob hello" })),
      ),
    );
    expect(promptText(model.prompts[1]!)).not.toContain("alice secret");
    const aliceRoute = await Effect.runPromise(routes.get(alice("shared")));
    const bobRoute = await Effect.runPromise(
      routes.get({ channel: "http", principal: "bob", conversation: "shared" }),
    );
    expect(aliceRoute).toEqual(expect.any(String));
    expect(bobRoute).toEqual(expect.any(String));
    expect(aliceRoute).not.toBe(bobRoute);
  });

  it("answers 409 for an overlapping Turn and releases the Route when the client disconnects", async () => {
    const model = hangingModel();
    const channel = http({ auth, routes: memoryRoutes() });
    const context = contextFor(agentWith(model.provider));

    const running = await channel.handle!(context, turnRequest("chat-1", "alice-token"));
    expect(running.status).toBe(200);
    const reader = frameReader(running);
    expect((await reader.next())?.event).toEqual({ type: "model-output", text: "thinking" });

    const overlap = await channel.handle!(context, turnRequest("chat-1", "alice-token"));
    expect(overlap.status).toBe(409);
    const other = await channel.handle!(context, turnRequest("chat-2", "bob-token"));
    expect(other.status).toBe(200);
    await frameReader(other).cancel();

    expect(model.released()).toBe(1);
    await reader.cancel();
    expect(model.released()).toBe(2);
    const after = await channel.handle!(context, turnRequest("chat-1", "alice-token"));
    expect(after.status).toBe(200);
    await frameReader(after).cancel();
    expect(model.released()).toBe(3);
  });

  it("interrupts the Turn when the request signal aborts", async () => {
    const model = hangingModel();
    const channel = http({ auth, routes: memoryRoutes() });
    const controller = new AbortController();
    const response = await channel.handle!(
      contextFor(agentWith(model.provider)),
      turnRequest("chat-1", "alice-token", undefined, { signal: controller.signal }),
    );
    const reader = frameReader(response);
    await reader.next();
    controller.abort();
    expect(await reader.rest()).toEqual([]);
    expect(model.released()).toBe(1);
  });

  it("reports a failure after headers as a final error frame", async () => {
    let calls = 0;
    const provider = makeTestProvider(() => {
      calls += 1;
      return Stream.concat(
        Stream.succeed({ type: "text-delta", id: "partial", delta: "partial" }),
        Stream.fail(
          AiError.make({
            module: "test",
            method: "streamText",
            reason: new AiError.UnknownError({ description: "upstream exploded" }),
          }),
        ),
      );
    });
    const channel = http({ auth, routes: memoryRoutes() });
    const response = await channel.handle!(
      contextFor(agentWith(provider)),
      turnRequest("chat-1", "alice-token"),
    );
    expect(response.status).toBe(200);
    const frames = await readFrames(response);
    expect(frames.map((frame) => frame.event.type)).toEqual(["model-output", "error"]);
    expect(frames[1]!.event).toEqual({ type: "error", message: "Turn failed" });
    expect(JSON.stringify(frames)).not.toContain("upstream exploded");
    expect(calls).toBe(1);
  });

  it("waits for the client to read before pulling more of the Turn", async () => {
    const total = 20;
    let consumed = 0;
    const third = Promise.withResolvers<void>();
    const provider = makeTestProvider(() =>
      Stream.fromIterable(Array.from({ length: total }, (_, index) => index)).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            consumed += 1;
            if (consumed === 3) third.resolve();
          }),
        ),
        Stream.map((index) => ({ type: "text-delta" as const, id: "reply", delta: `${index} ` })),
      ),
    );
    const channel = http({ auth, routes: memoryRoutes() });
    const response = await channel.handle!(
      contextFor(agentWith(provider)),
      turnRequest("chat-1", "alice-token"),
    );
    const reader = frameReader(response);
    expect((await reader.next())?.event).toEqual({ type: "model-output", text: "0 " });

    // One frame may sit in the queue; the next `send` blocks until the client reads it, so the
    // Model stream is pulled no further than that frame.
    await third.promise;
    expect(consumed).toBe(3);

    const rest = await reader.rest();
    expect(rest.filter((frame) => frame.event.type === "model-output")).toHaveLength(total - 1);
    expect(rest.at(-1)?.event.type).toBe("response-complete");
    expect(consumed).toBe(total);
  });

  it("answers 400, 404, and 405 before any Turn starts", async () => {
    const model = echoModel();
    const channel = http({ auth, routes: memoryRoutes() });
    const context = contextFor(agentWith(model.provider));
    const status = (request: Request) => channel.handle!(context, request).then((r) => r.status);

    expect(await status(turnRequest("chat-1", "alice-token", "not json"))).toBe(400);
    expect(await status(turnRequest("chat-1", "alice-token", JSON.stringify({ text: "x" })))).toBe(
      400,
    );
    for (const model of ["nomodel", "/", "/model", "test/"]) {
      expect(
        await status(turnRequest("chat-1", "alice-token", JSON.stringify({ message: "x", model }))),
      ).toBe(400);
    }
    const oversized = JSON.stringify({ message: "x".repeat(1_048_576) });
    expect(await status(turnRequest("chat-1", "alice-token", oversized))).toBe(413);
    expect(
      await status(
        new Request("http://channel.test/conversations/chat-1/turns", {
          method: "POST",
          headers: { authorization: "Bearer alice-token", "content-length": "2000000" },
          body: "{}",
        }),
      ),
    ).toBe(413);
    expect(
      await status(
        new Request("http://channel.test/conversations/chat-1/turns", {
          headers: { authorization: "Bearer alice-token" },
        }),
      ),
    ).toBe(405);
    expect(
      await status(
        new Request("http://channel.test/other", {
          headers: { authorization: "Bearer alice-token" },
        }),
      ),
    ).toBe(404);
    expect(await status(decisionRequest("t", "a", "alice-token", "approve"))).toBe(404);
    expect(model.prompts).toHaveLength(0);
  });
});

describe("http Channel Approvals", () => {
  const dangerous = { name: "dangerous", needsApproval: true };

  it("denies pending Approvals by default while unflagged and Agent-allowed Tools run", async () => {
    const model = toolModel([
      dangerous,
      { name: "plain", needsApproval: false },
      { name: "allowed", needsApproval: true },
    ]);
    const channel = http({ auth, routes: memoryRoutes(), name: "api" });
    const context = contextFor(
      agentWith(model.provider, [model.extension], { allow: ["allowed"] }),
    );
    const frames = await readFrames(
      await channel.handle!(context, turnRequest("chat-1", "alice-token")),
    );
    const results = frames.filter((frame) => frame.event.type === "tool-result");
    expect(results).toHaveLength(3);
    expect(results.map((frame) => frame.event)).toEqual(
      expect.arrayContaining([
        {
          type: "tool-result",
          id: "call-dangerous",
          name: "dangerous",
          result: {
            type: "execution-denied",
            reason:
              'Approval denied: the http Channel "api" does not resolve Approvals (set approvals: "interactive" or list the Tool under approvals.allow)',
          },
          isFailure: true,
        },
        {
          type: "tool-result",
          id: "call-plain",
          name: "plain",
          result: "executed",
          isFailure: false,
        },
        {
          type: "tool-result",
          id: "call-allowed",
          name: "allowed",
          result: "executed",
          isFailure: false,
        },
      ]),
    );
    expect(frames.filter((frame) => frame.event.type === "approval-required")).toHaveLength(1);
    expect(model.executions.get("dangerous")).toBeUndefined();
    expect(model.executions.get("plain")).toBe(1);
    expect(model.executions.get("allowed")).toBe(1);
    expect(frames.at(-1)?.event.type).toBe("response-complete");
  });

  it("approves a live Approval through the endpoint with its requirement metadata", async () => {
    const model = toolModel([dangerous]);
    const channel = http({ auth, routes: memoryRoutes(), approvals: "interactive" });
    const context = contextFor(agentWith(model.provider, [model.extension]));
    const reader = frameReader(
      await channel.handle!(context, turnRequest("chat-1", "alice-token")),
    );
    const pending = await reader.until("approval-required");
    expect(pending.event).toEqual({
      type: "approval-required",
      approvalId: expect.any(String),
      toolCallId: "call-dangerous",
      name: "dangerous",
      params: { action: "run" },
      requirement: "tool",
    });
    if (pending.event.type !== "approval-required") throw new Error("unreachable");

    const decided = await channel.handle!(
      context,
      decisionRequest(pending.turnId, pending.event.approvalId, "alice-token", "approve"),
    );
    expect(decided.status).toBe(204);
    const rest = await reader.rest();
    expect(rest.map((frame) => frame.event)).toContainEqual({
      type: "tool-result",
      id: "call-dangerous",
      name: "dangerous",
      result: "executed",
      isFailure: false,
    });
    expect(rest.at(-1)?.event.type).toBe("response-complete");
    expect(model.executions.get("dangerous")).toBe(1);

    const duplicate = await channel.handle!(
      context,
      decisionRequest(pending.turnId, pending.event.approvalId, "alice-token", "approve"),
    );
    expect(duplicate.status).toBe(404);
    expect(model.executions.get("dangerous")).toBe(1);
  });

  it("denies through the endpoint with the caller's reason and rejects other principals", async () => {
    const model = toolModel([dangerous]);
    const channel = http({ auth, routes: memoryRoutes(), approvals: "interactive" });
    const context = contextFor(agentWith(model.provider, [model.extension]));
    const reader = frameReader(
      await channel.handle!(context, turnRequest("chat-1", "alice-token")),
    );
    const pending = await reader.until("approval-required");
    if (pending.event.type !== "approval-required") throw new Error("unreachable");
    const { approvalId } = pending.event;

    const bob = await channel.handle!(
      context,
      decisionRequest(pending.turnId, approvalId, "bob-token", "approve"),
    );
    expect(bob.status).toBe(403);
    const anonymous = await channel.handle!(
      context,
      decisionRequest(pending.turnId, approvalId, "nobody", "approve"),
    );
    expect(anonymous.status).toBe(401);
    const malformed = await channel.handle!(
      context,
      new Request(`http://channel.test/turns/${pending.turnId}/approvals/${approvalId}`, {
        method: "POST",
        headers: { authorization: "Bearer alice-token" },
        body: JSON.stringify({ decision: "maybe" }),
      }),
    );
    expect(malformed.status).toBe(400);
    expect(model.executions.get("dangerous")).toBeUndefined();

    const denied = await channel.handle!(
      context,
      decisionRequest(pending.turnId, approvalId, "alice-token", "deny", "not today"),
    );
    expect(denied.status).toBe(204);
    const rest = await reader.rest();
    expect(rest.map((frame) => frame.event)).toContainEqual({
      type: "tool-result",
      id: "call-dangerous",
      name: "dangerous",
      result: { type: "execution-denied", reason: "not today" },
      isFailure: true,
    });
    expect(model.executions.get("dangerous")).toBeUndefined();
  });

  it("answers 404 for unknown ids and never re-executes a stale decision", async () => {
    const model = toolModel([dangerous]);
    const channel = http({ auth, routes: memoryRoutes(), approvals: "interactive" });
    const context = contextFor(agentWith(model.provider, [model.extension]));
    expect(
      (
        await channel.handle!(
          context,
          decisionRequest("no-turn", "no-approval", "alice-token", "approve"),
        )
      ).status,
    ).toBe(404);
    const reader = frameReader(
      await channel.handle!(context, turnRequest("chat-1", "alice-token")),
    );
    const pending = await reader.until("approval-required");
    if (pending.event.type !== "approval-required") throw new Error("unreachable");
    expect(
      (
        await channel.handle!(
          context,
          decisionRequest("other-turn", pending.event.approvalId, "alice-token", "approve"),
        )
      ).status,
    ).toBe(404);
    await channel.handle!(
      context,
      decisionRequest(pending.turnId, pending.event.approvalId, "alice-token", "deny"),
    );
    const rest = await reader.rest();
    expect(rest.map((frame) => frame.event)).toContainEqual({
      type: "tool-result",
      id: "call-dangerous",
      name: "dangerous",
      result: { type: "execution-denied", reason: "Approval denied by the user." },
      isFailure: true,
    });
    expect(
      (
        await channel.handle!(
          context,
          decisionRequest(pending.turnId, pending.event.approvalId, "alice-token", "approve"),
        )
      ).status,
    ).toBe(404);
    expect(model.executions.get("dangerous")).toBeUndefined();
  });

  it("denies an unanswered Approval when it times out", async () => {
    const model = toolModel([dangerous]);
    const channel = http({
      auth,
      routes: memoryRoutes(),
      approvals: "interactive",
      approvalTimeoutMs: 20,
      name: "api",
    });
    const context = contextFor(agentWith(model.provider, [model.extension]));
    const frames = await readFrames(
      await channel.handle!(context, turnRequest("chat-1", "alice-token")),
    );
    expect(frames.map((frame) => frame.event)).toContainEqual({
      type: "tool-result",
      id: "call-dangerous",
      name: "dangerous",
      result: {
        type: "execution-denied",
        reason:
          'Approval denied: the http Channel "api" received no decision before the Approval timed out',
      },
      isFailure: true,
    });
    expect(model.executions.get("dangerous")).toBeUndefined();
    const pending = frames.find((frame) => frame.event.type === "approval-required")!;
    if (pending.event.type !== "approval-required") throw new Error("unreachable");
    expect(
      (
        await channel.handle!(
          context,
          decisionRequest(pending.turnId, pending.event.approvalId, "alice-token", "approve"),
        )
      ).status,
    ).toBe(404);
  });

  it("forgets pending Approvals when the Turn is interrupted", async () => {
    const model = toolModel([dangerous]);
    const channel = http({ auth, routes: memoryRoutes(), approvals: "interactive" });
    const context = contextFor(agentWith(model.provider, [model.extension]));
    const reader = frameReader(
      await channel.handle!(context, turnRequest("chat-1", "alice-token")),
    );
    const pending = await reader.until("approval-required");
    if (pending.event.type !== "approval-required") throw new Error("unreachable");
    await reader.cancel();
    expect(
      (
        await channel.handle!(
          context,
          decisionRequest(pending.turnId, pending.event.approvalId, "alice-token", "approve"),
        )
      ).status,
    ).toBe(404);
    expect(model.executions.get("dangerous")).toBeUndefined();
    expect(model.steps()).toBe(1);
  });
});
