import { describe, expect, it } from "vitest";
import { type RouteKey, memoryRoutes } from "@mitome/core";
import { Effect } from "effect";
import { TelegramApiError, telegram } from "../../src/telegram/index.js";
import {
  agentWith,
  contextFor,
  echoModel,
  hangingModel,
  promptText,
  toolModel,
} from "../support/agent.js";
import { fakeApi, serving, waitFor } from "./support.js";

const alice = 1001;
const bob = 1002;
const stranger = 4004;
const allow = [alice, String(bob)];
const route = (principal: number, conversation: string): RouteKey => ({
  channel: "telegram",
  principal: String(principal),
  conversation,
});

describe("telegram Channel Turns", () => {
  it("answers an allowed sender and resumes the chat after a restart", async () => {
    const model = echoModel("reply");
    const routes = memoryRoutes();
    const context = contextFor(agentWith(model.provider));
    const first = fakeApi();
    const running = serving(telegram({ token: "t", allow, routes, api: first.api }), context);

    first.message(alice, "hello");
    await waitFor(() => first.sent.length === 1);
    expect(first.sent[0]).toEqual({ chat_id: alice, message_thread_id: undefined, text: "reply" });
    const transcriptId = await Effect.runPromise(routes.get(route(alice, String(alice))));
    expect(transcriptId).toEqual(expect.any(String));
    expect(model.released()).toBe(1);
    await running.stop();

    const second = fakeApi();
    const restarted = serving(telegram({ token: "t", allow, routes, api: second.api }), context);
    second.message(alice, "again");
    await waitFor(() => second.sent.length === 1);
    expect(promptText(model.prompts[1]!)).toContain("hello");
    expect(promptText(model.prompts[1]!)).toContain("again");
    expect(await Effect.runPromise(routes.get(route(alice, String(alice))))).not.toBe(transcriptId);
    await restarted.stop();
  });

  it("keeps a forum topic on its own Route and answers in the thread", async () => {
    const model = echoModel();
    const routes = memoryRoutes();
    const fake = fakeApi();
    const running = serving(
      telegram({ token: "t", allow, routes, api: fake.api }),
      contextFor(agentWith(model.provider)),
    );
    fake.message(alice, "in topic", -500, 7);
    await waitFor(() => fake.sent.length === 1);
    expect(fake.sent[0]).toMatchObject({ chat_id: -500, message_thread_id: 7 });
    expect(await Effect.runPromise(routes.get(route(alice, "-500/7")))).toEqual(expect.any(String));
    expect(await Effect.runPromise(routes.get(route(alice, "-500")))).toBeUndefined();
    await running.stop();
  });

  it("stays silent for a sender outside the allowlist and starts no Session", async () => {
    const model = echoModel();
    const fake = fakeApi();
    const running = serving(
      telegram({ token: "t", allow, routes: memoryRoutes(), api: fake.api }),
      contextFor(agentWith(model.provider)),
    );
    fake.message(stranger, "let me in");
    fake.message(stranger, "/start");
    fake.callback(stranger, "approve:anything");
    fake.message(bob, "hi");
    await waitFor(() => fake.sent.length === 1);
    expect(fake.sent[0]).toMatchObject({ chat_id: bob });
    expect(fake.answered).toEqual([]);
    expect(model.prompts).toHaveLength(1);
    await running.stop();
  });

  it("starts fresh on /new while the previous Transcript stays in the store", async () => {
    const model = echoModel();
    const routes = memoryRoutes();
    const context = contextFor(agentWith(model.provider));
    const fake = fakeApi();
    const running = serving(telegram({ token: "t", allow, routes, api: fake.api }), context);
    fake.message(alice, "remember this");
    await waitFor(() => fake.sent.length === 1);
    const previous = (await Effect.runPromise(routes.get(route(alice, String(alice)))))!;

    fake.message(alice, "/new@my_bot");
    await waitFor(() => fake.sent.length === 2);
    expect(fake.sent[1]!.text).toBe("Started a new conversation.");
    expect(await Effect.runPromise(routes.get(route(alice, String(alice))))).toBeUndefined();

    fake.message(alice, "fresh");
    await waitFor(() => fake.sent.length === 3);
    expect(promptText(model.prompts[1]!)).not.toContain("remember this");
    const loaded = await Effect.runPromise(context.transcripts!.load(previous));
    expect(loaded.id).toBe(previous);
    await running.stop();
  });

  it("starts fresh when the Route names a Transcript that no longer loads", async () => {
    const model = echoModel();
    const routes = memoryRoutes();
    await Effect.runPromise(routes.set(route(alice, String(alice)), "gone"));
    const fake = fakeApi();
    const running = serving(
      telegram({ token: "t", allow, routes, api: fake.api }),
      contextFor(agentWith(model.provider)),
    );
    fake.message(alice, "hello");
    await waitFor(() => fake.sent.length === 1);
    expect(await Effect.runPromise(routes.get(route(alice, String(alice))))).not.toBe("gone");
    await running.stop();
  });

  it("splits a long reply at Telegram's message limit", async () => {
    const model = echoModel("x".repeat(5000));
    const fake = fakeApi();
    const running = serving(
      telegram({ token: "t", allow, routes: memoryRoutes(), api: fake.api }),
      contextFor(agentWith(model.provider)),
    );
    fake.message(alice, "long");
    await waitFor(() => fake.sent.length === 2);
    expect(fake.sent.map((sent) => sent.text.length)).toEqual([4096, 904]);
    await running.stop();
  });

  it("stops polling on abort and interrupts the running Turn", async () => {
    const model = hangingModel();
    const fake = fakeApi();
    const running = serving(
      telegram({ token: "t", allow, routes: memoryRoutes(), api: fake.api }),
      contextFor(agentWith(model.provider)),
    );
    fake.message(alice, "hang");
    await waitFor(() => fake.polls.length === 2);
    await running.stop();
    expect(model.released()).toBe(1);
    const pollsAtStop = fake.polls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.polls.length).toBe(pollsAtStop);
    expect(fake.sent).toEqual([]);
  });

  it("backs off for retry_after and keeps polling after a transport failure", async () => {
    const model = echoModel();
    const fake = fakeApi();
    fake.failNextPoll(
      new TelegramApiError({
        method: "getUpdates",
        description: "Too Many Requests",
        retryAfterMs: 60,
      }),
    );
    const running = serving(
      telegram({ token: "t", allow, routes: memoryRoutes(), api: fake.api }),
      contextFor(agentWith(model.provider)),
    );
    fake.message(alice, "after the backoff");
    await waitFor(() => fake.sent.length === 1);
    expect(fake.polls[1]!.at - fake.polls[0]!.at).toBeGreaterThanOrEqual(55);
    expect(fake.polls[1]!.params.offset).toBeUndefined();
    await waitFor(() => fake.polls.length === 3);
    expect(fake.polls[2]!.params.offset).toBe(2);
    await running.stop();
  });
});

describe("telegram Channel Approvals", () => {
  const dangerous = { name: "dangerous", needsApproval: true };

  it("denies pending Approvals by default while unflagged and Agent-allowed Tools run", async () => {
    const model = toolModel([
      dangerous,
      { name: "plain", needsApproval: false },
      { name: "allowed", needsApproval: true },
    ]);
    const routes = memoryRoutes();
    const context = contextFor(
      agentWith(model.provider, [model.extension], { allow: ["allowed"] }),
    );
    const fake = fakeApi();
    const running = serving(telegram({ token: "t", allow, routes, api: fake.api }), context);
    fake.message(alice, "go");
    await waitFor(() => fake.sent.length === 1);
    expect(fake.sent[0]!.text).toBe("done");
    expect(fake.sent[0]!.reply_markup).toBeUndefined();
    expect(model.executions.get("dangerous")).toBeUndefined();
    expect(model.executions.get("plain")).toBe(1);
    expect(model.executions.get("allowed")).toBe(1);
    const transcriptId = (await Effect.runPromise(routes.get(route(alice, String(alice)))))!;
    const transcript = await Effect.runPromise(context.transcripts!.load(transcriptId));
    const denial =
      'Approval denied: the telegram Channel "telegram" does not resolve Approvals (set approvals: "interactive" or list the Tool under approvals.allow)';
    expect(JSON.stringify(transcript)).toContain(JSON.stringify(denial).slice(1, -1));
    await running.stop();
  });

  it("prompts with an inline keyboard, rejects other users and chats, and runs the Tool once approved", async () => {
    const model = toolModel([dangerous]);
    const fake = fakeApi();
    const running = serving(
      telegram({
        token: "t",
        allow,
        routes: memoryRoutes(),
        approvals: "interactive",
        api: fake.api,
      }),
      contextFor(agentWith(model.provider, [model.extension])),
    );
    fake.message(alice, "go", -500);
    await waitFor(() => fake.sent.length === 1);
    const prompt = fake.sent[0]!;
    expect(prompt.chat_id).toBe(-500);
    expect(prompt.text).toBe('Tool dangerous (tool) wants to run: {"action":"run"}');
    const approve = fake.callbackFor(prompt, "approve");
    expect(approve).toMatch(/^approve:.+$/);
    expect(fake.callbackFor(prompt, "deny")).toBe(approve.replace(/^approve/, "deny"));
    expect(Buffer.byteLength(approve)).toBeLessThanOrEqual(64);

    // Bob is allowlisted and in the same group, but the Turn is Alice's.
    fake.callback(bob, approve, -500);
    await waitFor(() => fake.answered.length === 1);
    expect(fake.answered[0]!.text).toBe("This Approval is not yours to decide.");
    // Alice from another chat is not the conversation the Turn runs in.
    fake.callback(alice, approve, alice);
    await waitFor(() => fake.answered.length === 2);
    expect(fake.answered[1]!.text).toBe("This Approval is not yours to decide.");
    expect(model.executions.get("dangerous")).toBeUndefined();

    // A message on the busy Route is dropped while the decision goes through.
    fake.message(alice, "hurry up", -500);
    await waitFor(() => fake.sent.length === 2);
    expect(fake.sent[1]!.text).toBe("Still working on your previous message.");
    fake.callback(alice, approve, -500);
    await waitFor(() => fake.sent.length === 3);
    expect(fake.answered[2]!.text).toBe("Approved.");
    expect(fake.sent[2]!.text).toBe("done");
    expect(model.executions.get("dangerous")).toBe(1);
    expect(model.steps()).toBe(2);

    fake.callback(alice, approve, -500);
    await waitFor(() => fake.answered.length === 4);
    expect(fake.answered[3]!.text).toBe("This Approval is no longer pending.");
    expect(model.executions.get("dangerous")).toBe(1);
    await running.stop();
  });

  it("denies through the keyboard and treats unknown or repeated decisions as no longer pending", async () => {
    const model = toolModel([dangerous]);
    const fake = fakeApi();
    const running = serving(
      telegram({
        token: "t",
        allow,
        routes: memoryRoutes(),
        approvals: "interactive",
        api: fake.api,
      }),
      contextFor(agentWith(model.provider, [model.extension])),
    );
    fake.callback(alice, "approve:nothing");
    fake.callback(alice, "garbage");
    await waitFor(() => fake.answered.length === 2);
    expect(fake.answered.map((answer) => answer.text)).toEqual([
      "This Approval is no longer pending.",
      "This Approval is no longer pending.",
    ]);

    fake.message(alice, "go");
    await waitFor(() => fake.sent.length === 1);
    fake.callback(alice, fake.callbackFor(fake.sent[0]!, "deny"));
    await waitFor(() => fake.sent.length === 2);
    expect(fake.answered[2]!.text).toBe("Denied.");
    expect(fake.sent[1]!.text).toBe("done");
    expect(model.executions.get("dangerous")).toBeUndefined();
    await running.stop();
  });

  it("denies an unanswered Approval when it times out", async () => {
    const model = toolModel([dangerous]);
    const fake = fakeApi();
    const running = serving(
      telegram({
        token: "t",
        allow,
        routes: memoryRoutes(),
        approvals: "interactive",
        approvalTimeoutMs: 20,
        api: fake.api,
      }),
      contextFor(agentWith(model.provider, [model.extension])),
    );
    fake.message(alice, "go");
    await waitFor(() => fake.sent.length === 2);
    expect(fake.sent[1]!.text).toBe("done");
    expect(model.executions.get("dangerous")).toBeUndefined();
    fake.callback(alice, fake.callbackFor(fake.sent[0]!, "approve"));
    await waitFor(() => fake.answered.length === 1);
    expect(fake.answered[0]!.text).toBe("This Approval is no longer pending.");
    expect(model.executions.get("dangerous")).toBeUndefined();
    await running.stop();
  });

  it("forgets pending Approvals when shutdown interrupts the Turn", async () => {
    const model = toolModel([dangerous]);
    const fake = fakeApi();
    const running = serving(
      telegram({
        token: "t",
        allow,
        routes: memoryRoutes(),
        approvals: "interactive",
        api: fake.api,
      }),
      contextFor(agentWith(model.provider, [model.extension])),
    );
    fake.message(alice, "go");
    await waitFor(() => fake.sent.length === 1);
    await running.stop();
    expect(model.executions.get("dangerous")).toBeUndefined();
    expect(model.steps()).toBe(1);
    expect(fake.sent).toHaveLength(1);
  });
});
