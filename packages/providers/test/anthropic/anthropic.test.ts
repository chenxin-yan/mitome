import {
  chmod,
  constants,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Schema,
  Scheduler,
  Stream,
} from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/ai";
import type { Response as AiResponse } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { Provider } from "@mitome/core";
import { fakeFetch as answerEveryOrigin, runWithKey } from "../support.js";
import { anthropic, authenticate } from "../../src/anthropic/index.js";
import { tokenSource } from "../../src/anthropic/profile.js";
import { platformLayer } from "../../src/shared/platform.js";

const key = "MITOME_ANTHROPIC_TEST_KEY";
const run = runWithKey(key);

// Every Provider here reads Anthropic profiles from this directory, never the user's own, and a
// fallback to the home directory finds an empty one.
const configDirectory = await mkdtemp(join(tmpdir(), "mitome-anthropic-config-"));
const home = await mkdtemp(join(tmpdir(), "mitome-anthropic-home-"));
process.env.ANTHROPIC_CONFIG_DIR = configDirectory;
process.env.HOME = home;
afterAll(() =>
  Promise.all([configDirectory, home].map((path) => rm(path, { recursive: true, force: true }))),
);

const testOrigin = "https://test.invalid";

/** A scripted fetch that refuses every origin but the given ones, so no test reaches a real server. */
const fakeFetch = (
  handle: (request: Request) => Response | Promise<Response>,
  origins: ReadonlyArray<string> = [testOrigin],
) =>
  answerEveryOrigin((request) => {
    const origin = new URL(request.url).origin;
    if (!origins.includes(origin)) {
      throw new Error(`No test answers ${origin}`);
    }
    return handle(request);
  });

const message = (content: ReadonlyArray<unknown>) => ({
  id: "msg-1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-6",
  content,
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    service_tier: "standard",
  },
});

/** The basic streaming example of Anthropic's streaming documentation, byte for byte. */
const documentedStream = () =>
  new Response(
    [
      'event: message_start\ndata: {"type": "message_start", "message": {"id": "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY", "type": "message", "role": "assistant", "content": [], "model": "claude-opus-4-6", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 25, "output_tokens": 1}}}',
      'event: content_block_start\ndata: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}',
      'event: ping\ndata: {"type": "ping"}',
      'event: content_block_delta\ndata: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}',
      'event: content_block_delta\ndata: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "!"}}',
      'event: content_block_stop\ndata: {"type": "content_block_stop", "index": 0}',
      'event: message_delta\ndata: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence":null}, "usage": {"output_tokens": 15}}',
      'event: message_stop\ndata: {"type": "message_stop"}',
    ]
      .map((event) => `${event}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const textDeltas = (parts: ReadonlyArray<AiResponse.AnyPart>) =>
  parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []));

interface SentBody {
  readonly tools?: ReadonlyArray<{ readonly strict?: boolean }>;
}

/** Answers every request with `text` and records each parsed request body. */
const capture = (text: string) => {
  const bodies: Array<SentBody> = [];
  const fetch = fakeFetch(async (request) => {
    // SAFETY: this controlled client request is emitted from the Anthropic request schema.
    bodies.push((await request.json()) as SentBody);
    return Response.json(message([{ type: "text", text }]));
  });
  return { bodies, fetch };
};

describe("anthropic", () => {
  it("exposes its credential descriptor without provisioning a Model", () => {
    const module = new URL("../../src/anthropic/index.ts", import.meta.url).href;
    expect(Provider.credentialDescriptor(anthropic())).toEqual({
      env: "ANTHROPIC_API_KEY",
      capability: { module, profile: "mitome" },
    });
    expect(
      Provider.credentialDescriptor(
        anthropic({ apiKeyEnv: "MITOME_TEST_API_KEY", profile: "work" }),
      ),
    ).toEqual({ env: "MITOME_TEST_API_KEY", capability: { module, profile: "work" } });
  });

  it("passes model ids unchanged and decodes Anthropic's simplest documented stream, which omits optional usage fields", async () => {
    const requests: Array<{
      readonly path: string;
      readonly model: string;
      readonly maxTokens: number;
      readonly stream: boolean;
      readonly apiKey: string | null;
      readonly version: string | null;
    }> = [];
    const fetch = fakeFetch(async (request) => {
      // SAFETY: this controlled client request is emitted from the Anthropic request schema.
      const body = (await request.json()) as { model: string; max_tokens: number; stream: boolean };
      requests.push({
        path: new URL(request.url).pathname,
        model: body.model,
        maxTokens: body.max_tokens,
        stream: body.stream,
        apiKey: request.headers.get("x-api-key"),
        version: request.headers.get("anthropic-version"),
      });
      return documentedStream();
    });

    const provider = anthropic({ apiKeyEnv: key, baseUrl: "https://test.invalid/" });
    const parts = await run(
      Stream.runCollect(LanguageModel.streamText({ prompt: "Hi" })).pipe(
        Effect.provide(Provider.model(provider, "claude-unlisted-test-model")),
      ),
      fetch,
    );
    expect(textDeltas([...parts])).toEqual(["Hello", "!"]);
    expect([...parts].at(-1)).toMatchObject({
      type: "finish",
      reason: "stop",
      usage: { inputTokens: { total: 25 }, outputTokens: { total: 15 } },
    });
    expect(requests).toEqual([
      {
        path: "/v1/messages",
        model: "claude-unlisted-test-model",
        maxTokens: expect.any(Number),
        stream: true,
        apiKey: "synthetic-key",
        version: "2023-06-01",
      },
    ]);
    expect(Number.isInteger(requests[0]?.maxTokens)).toBe(true);
    expect(requests[0]?.maxTokens).toBeGreaterThan(0);
  });

  // Anthropic accepts at most 20 strict Tools per request.
  it("sends more than 20 ordinary Tools without marking them strict", async () => {
    const tools = Array.from({ length: 21 }, (_, index) =>
      Tool.make(`tool${index}`, { parameters: Schema.Struct({ key: Schema.String }) }),
    );
    const { bodies, fetch } = capture("done");
    await run(
      LanguageModel.generateText({
        prompt: "Hi",
        toolkit: Toolkit.make(...tools),
        disableToolCallResolution: true,
      }).pipe(
        Effect.provide(
          Provider.model(
            anthropic({ apiKeyEnv: key, baseUrl: "https://test.invalid" }),
            "claude-sonnet-4-6",
          ),
        ),
      ),
      fetch,
    );
    const sent = bodies[0]?.tools ?? [];
    expect(sent).toHaveLength(21);
    expect(sent.filter((tool) => tool.strict === true)).toEqual([]);
  });

  it("asks a capable Model for a native JSON output format in generateObject", async () => {
    const { bodies, fetch } = capture('{"answer":"yes"}');
    const result = await run(
      LanguageModel.generateObject({
        prompt: "Hi",
        schema: Schema.Struct({ answer: Schema.String }),
      }).pipe(
        Effect.provide(
          Provider.model(
            anthropic({ apiKeyEnv: key, baseUrl: "https://test.invalid" }),
            "claude-sonnet-4-6",
          ),
        ),
      ),
      fetch,
    );
    expect(result.value).toEqual({ answer: "yes" });
    expect(bodies[0]).toMatchObject({ output_config: { format: { type: "json_schema" } } });
    expect(bodies[0]).not.toHaveProperty("tools");
    expect(bodies[0]).not.toHaveProperty("tool_choice");
  });

  it("fails first use naming both Credentials when neither is present", async () => {
    const previous = process.env[key];
    delete process.env[key];
    let requests = 0;
    const fetch = fakeFetch(() => {
      requests += 1;
      throw new Error("a missing credential must not reach the network");
    });
    try {
      const provider = anthropic({ apiKeyEnv: key });
      const error = await run(
        Effect.flip(
          LanguageModel.generateText({ prompt: "Hi" }).pipe(
            Effect.provide(Provider.model(provider, "claude-sonnet-4-6")),
          ),
        ),
        fetch,
        {},
      );
      expect(error).toMatchObject({
        _tag: "MissingCredentialError",
        message: `Environment variable ${key} is not set or empty. Set it to an API key, or sign in to the Claude Console: run \`mitome auth login --provider anthropic\` (or \`ant auth login --profile=mitome\`).`,
      });
      expect(requests).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });
});

describe("anthropic with the Claude Console profile", () => {
  const unsetKey = "MITOME_ANTHROPIC_UNSET_TEST_KEY";
  const baseUrl = testOrigin;
  const nowSeconds = () => Math.floor(Date.now() / 1_000);
  const posix = process.platform !== "win32";
  let profiles = 0;

  const configPath = (name: string) => join(configDirectory, "configs", `${name}.json`);

  /** Writes a profile as `ant auth login` does; `credentials` undefined leaves it signed out. */
  const writeProfile = async (
    config: Schema.Json,
    credentials: Schema.Json | undefined,
    mode = 0o600,
  ) => {
    profiles += 1;
    const name = `profile-${profiles}`;
    await mkdir(join(configDirectory, "configs"), { recursive: true });
    await mkdir(join(configDirectory, "credentials"), { recursive: true, mode: 0o700 });
    await writeFile(configPath(name), JSON.stringify(config));
    // As the messages name it: the file itself, whatever links lead to it.
    const credentialsPath = join(
      await realpath(join(configDirectory, "credentials")),
      `${name}.json`,
    );
    if (credentials !== undefined) {
      await writeFile(credentialsPath, JSON.stringify(credentials));
      await chmod(credentialsPath, mode);
    }
    return { name, credentialsPath };
  };

  /** A profile `ant auth login` wrote for Anthropic's own host, which it then names no host for. */
  const anthropicIssued = {
    version: "1.0",
    authentication: { type: "user_oauth", client_id: "client-from-profile" },
    organization_id: "org-1",
  };

  /** A profile issued by the test host, which therefore refreshes its tokens. */
  const userOAuth = (fields: Record<string, Schema.Json> = {}) => ({
    ...anthropicIssued,
    base_url: testOrigin,
    ...fields,
  });

  const tokens = (
    accessToken: string,
    expiresAt: number,
    fields: Record<string, Schema.Json> = {},
  ) => ({
    version: "1.0",
    type: "oauth_token",
    access_token: accessToken,
    expires_at: expiresAt,
    refresh_token: "refresh-1",
    scope: "user:profile user:inference user:developer",
    account_email: "person@example.com",
    ...fields,
  });

  interface TokenRequest {
    readonly url: string;
    readonly redirect: Request["redirect"];
    readonly contentType: string | null;
    readonly beta: string | null;
    readonly body: Schema.Json;
  }

  /** Answers Model requests with text and token requests with `tokenReply`, recording both. */
  const upstream = (
    tokenReply: () => Response | Promise<Response> = () =>
      Response.json({ access_token: "access-2", expires_in: 3_600, refresh_token: "refresh-2" }),
  ) => {
    const model: Array<Headers> = [];
    const token: Array<TokenRequest> = [];
    const fetch = fakeFetch(async (request) => {
      if (new URL(request.url).pathname === "/v1/oauth/token") {
        token.push({
          url: request.url,
          redirect: request.redirect,
          contentType: request.headers.get("content-type"),
          beta: request.headers.get("anthropic-beta"),
          body: Schema.decodeUnknownSync(Schema.Json)(await request.json()),
        });
        return tokenReply();
      }
      model.push(request.headers);
      return Response.json(message([{ type: "text", text: "ok" }]));
    });
    return { model, token, fetch };
  };

  const authorizations = (model: ReadonlyArray<Headers>) =>
    model.map((headers) => headers.get("authorization"));

  const layerOf = (profile: string, options: { readonly baseUrl?: string } = { baseUrl }) =>
    Provider.model(anthropic({ apiKeyEnv: unsetKey, ...options, profile }), "claude-sonnet-4-6");

  const generate = (profile: string, fetch: typeof globalThis.fetch, config = {}) =>
    run(
      LanguageModel.generateText({ prompt: "Hi" }).pipe(Effect.provide(layerOf(profile))),
      fetch,
      config,
    );

  const failure = (profile: string, fetch: typeof globalThis.fetch) =>
    run(
      Effect.flip(
        LanguageModel.generateText({ prompt: "Hi" }).pipe(Effect.provide(layerOf(profile))),
      ),
      fetch,
      {},
    );

  /** The failure of provisioning the Model alone, before any request. */
  const provisioning = (
    profile: string,
    fetch: typeof globalThis.fetch,
    options?: { readonly baseUrl?: string },
  ) =>
    run(
      Effect.flip(Effect.scoped(Effect.asVoid(Layer.build(layerOf(profile, options))))),
      fetch,
      {},
    );

  /** Every way the failure could be shown or stored. */
  const renderings = (error: Error) => [
    String(error),
    JSON.stringify(error),
    Cause.pretty(Cause.fail(error)),
  ];

  it("sends an API key unchanged when one is set, even beside a profile", async () => {
    const { name } = await writeProfile(userOAuth(), tokens("access-1", nowSeconds() + 3_600));
    const { model, token, fetch } = upstream();
    await generate(name, fetch, { [unsetKey]: "synthetic-key" });
    expect(model).toHaveLength(1);
    expect(model[0]?.get("x-api-key")).toBe("synthetic-key");
    expect(model[0]?.get("authorization")).toBeNull();
    expect(model[0]?.get("anthropic-beta")).toBeNull();
    expect(token).toEqual([]);
  });

  it("authenticates with the profile's token, merging the OAuth beta and naming the workspace", async () => {
    const { name } = await writeProfile(
      userOAuth({ workspace_id: "wrkspc_1" }),
      tokens("access-1", nowSeconds() + 3_600),
    );
    const { model, token, fetch } = upstream();
    await run(
      LanguageModel.generateText({
        prompt: "Hi",
        toolkit: Toolkit.make(
          Tool.make("lookup", { parameters: Schema.Struct({ key: Schema.String }) }),
        ),
        disableToolCallResolution: true,
      }).pipe(Effect.provide(layerOf(name))),
      fetch,
      {},
    );
    expect(model).toHaveLength(1);
    expect(model[0]?.get("authorization")).toBe("Bearer access-1");
    expect(model[0]?.get("x-api-key")).toBeNull();
    // The Tool request carries the library's own beta, which the OAuth beta joins.
    expect(model[0]?.get("anthropic-beta")).toBe("structured-outputs-2025-11-13,oauth-2025-04-20");
    expect(model[0]?.get("anthropic-workspace-id")).toBe("wrkspc_1");
    expect(token).toEqual([]);
  });

  it("refreshes an expiring token once with the profile's client id, rewriting the file atomically", async () => {
    const { name, credentialsPath } = await writeProfile(
      userOAuth(),
      tokens("access-1", nowSeconds() + 10, {
        organization_name: "Example",
        custom: { kept: true },
      }),
    );
    const { model, token, fetch } = upstream();
    const before = nowSeconds();
    // A rename leaves a reader that already has the file open on the old contents; an overwrite in
    // place would not.
    const reader = await open(credentialsPath, "r");
    try {
      await generate(name, fetch);
      expect(JSON.parse(await reader.readFile("utf8")).access_token).toBe("access-1");
    } finally {
      await reader.close();
    }
    expect(token).toEqual([
      {
        url: `${baseUrl}/v1/oauth/token`,
        redirect: "manual",
        contentType: "application/json",
        beta: "oauth-2025-04-20",
        body: {
          grant_type: "refresh_token",
          refresh_token: "refresh-1",
          client_id: "client-from-profile",
        },
      },
    ]);
    expect(authorizations(model)).toEqual(["Bearer access-2"]);
    const rewritten = JSON.parse(await readFile(credentialsPath, "utf8"));
    expect(rewritten).toEqual({
      ...tokens("access-2", rewritten.expires_at, {
        organization_name: "Example",
        custom: { kept: true },
      }),
      refresh_token: "refresh-2",
    });
    expect(rewritten.expires_at).toBeGreaterThanOrEqual(before + 3_600);
    // Windows has no POSIX modes, and Mitome checks them only elsewhere.
    if (posix) {
      expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
    }
    // No temporary copy or lock is left beside it.
    expect(
      (await readdir(join(configDirectory, "credentials"))).filter((file) => file.startsWith(name)),
    ).toEqual([`${name}.json`]);
  });

  it("refreshes once for concurrent requests", async () => {
    const { name } = await writeProfile(userOAuth(), tokens("access-1", nowSeconds() - 10));
    const { model, token, fetch } = upstream(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ access_token: "access-2", expires_in: 3_600 });
    });
    await run(
      Effect.all(
        [LanguageModel.generateText({ prompt: "a" }), LanguageModel.generateText({ prompt: "b" })],
        { concurrency: 2 },
      ).pipe(Effect.provide(layerOf(name))),
      fetch,
      {},
    );
    expect(token).toHaveLength(1);
    expect(authorizations(model)).toEqual(["Bearer access-2", "Bearer access-2"]);
  });

  it("shares one failed refresh among concurrent requests", async () => {
    const { name } = await writeProfile(userOAuth(), tokens("access-1", nowSeconds() - 10));
    const { model, token, fetch } = upstream(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ error: "temporarily_unavailable" }, { status: 429 });
    });
    const errors = await run(
      Effect.all(
        [
          Effect.flip(LanguageModel.generateText({ prompt: "a" })),
          Effect.flip(LanguageModel.generateText({ prompt: "b" })),
        ],
        { concurrency: 2 },
      ).pipe(Effect.provide(layerOf(name))),
      fetch,
      {},
    );
    expect(token).toHaveLength(1);
    expect(model).toEqual([]);
    const temporary = `The Anthropic sign-in of profile "${name}" could not be refreshed right now (HTTP 429); try again later.`;
    for (const error of errors) {
      expect(error.message).toContain(temporary);
      expect(error).toMatchObject({ reason: { _tag: "InternalProviderError", isRetryable: true } });
    }
  });

  it("persists a rotated token when the request that refreshed it is interrupted", async () => {
    const { name, credentialsPath } = await writeProfile(
      userOAuth(),
      tokens("access-1", nowSeconds() - 10),
    );
    let answered = () => {};
    const exchanged = new Promise<void>((resolve) => (answered = resolve));
    const { model, token, fetch } = upstream(() => {
      answered();
      // The endpoint has rotated the grant; its body arrives after the caller is interrupted.
      const body = JSON.stringify({
        access_token: "access-2",
        expires_in: 3_600,
        refresh_token: "refresh-2",
      });
      return new Response(
        new ReadableStream({
          start: (controller) =>
            void setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            }, 100),
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    // The only caller: nothing else keeps the refresh alive once it is interrupted.
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layerOf(name));
          const only = yield* Effect.forkChild(
            LanguageModel.generateText({ prompt: "a" }).pipe(Effect.provideContext(context)),
          );
          yield* Effect.promise(() => exchanged);
          yield* Fiber.interrupt(only);
          expect(Exit.hasInterrupts(yield* Fiber.await(only))).toBe(true);
          expect(
            JSON.parse(yield* Effect.promise(() => readFile(credentialsPath, "utf8"))),
          ).toMatchObject({ access_token: "access-2", refresh_token: "refresh-2" });
          expect(
            yield* Effect.promise(() =>
              stat(`${credentialsPath}.lock`).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false);
        }),
      ),
      fetch,
      {},
    );
    expect(token).toHaveLength(1);
    expect(model).toEqual([]);
  });

  it("sends no exchange for a caller interrupted while it waits for the lock", async () => {
    const { name, credentialsPath } = await writeProfile(
      userOAuth(),
      tokens("access-1", nowSeconds() - 10),
    );
    // Another Mitome process is refreshing.
    const lock = `${credentialsPath}.lock`;
    await writeFile(lock, "");
    const { model, token, fetch } = upstream();
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layerOf(name));
          const waiting = yield* Effect.forkChild(
            LanguageModel.generateText({ prompt: "a" }).pipe(Effect.provideContext(context)),
          );
          yield* Effect.sleep("100 millis");
          yield* Fiber.interrupt(waiting);
        }),
      ),
      fetch,
      {},
    );
    expect(await readFile(lock, "utf8")).toBe("");
    await rm(lock);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(token).toEqual([]);
    expect(model).toEqual([]);
  });

  it("lets a caller waiting on a refresh refresh itself when the caller that started it is interrupted first", async () => {
    const { name, credentialsPath } = await writeProfile(
      userOAuth(),
      tokens("access-1", nowSeconds() - 10),
    );
    const lock = `${credentialsPath}.lock`;
    await writeFile(lock, "");
    const { model, token, fetch } = upstream();
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layerOf(name));
          const generate = LanguageModel.generateText({ prompt: "a" }).pipe(
            Effect.provideContext(context),
          );
          const first = yield* Effect.forkChild(generate);
          yield* Effect.sleep("50 millis");
          const second = yield* Effect.forkChild(generate);
          yield* Effect.sleep("50 millis");
          yield* Fiber.interrupt(first);
          yield* Effect.promise(() => rm(lock));
          yield* Fiber.join(second);
        }),
      ),
      fetch,
      {},
    );
    expect(token).toHaveLength(1);
    expect(authorizations(model)).toEqual(["Bearer access-2"]);
  });

  it("leaves later callers able to refresh wherever the caller starting a refresh is interrupted", async () => {
    const { name, credentialsPath } = await writeProfile(
      userOAuth(),
      tokens("access-1", nowSeconds() - 10),
    );
    const { fetch } = upstream();
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layerOf(name));
          const generate = LanguageModel.generateText({ prompt: "a" }).pipe(
            Effect.provideContext(context),
          );
          // The caller reads the clock to see that its token is stale, just before it refreshes.
          const clock = yield* Clock.Clock;
          let onRead: (() => void) | undefined;
          const signalling: Clock.Clock = {
            currentTimeMillisUnsafe: () => {
              const read = onRead;
              onRead = undefined;
              read?.();
              return clock.currentTimeMillisUnsafe();
            },
            currentTimeMillis: Effect.sync(() => signalling.currentTimeMillisUnsafe()),
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            currentTimeNanos: clock.currentTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            sleep: (duration) => clock.sleep(duration),
          };
          // Each round interrupts the first caller one scheduler step later, through the start
          // of its refresh.
          for (let steps = 0; steps < 60; steps++) {
            const stale = JSON.stringify(tokens("access-1", nowSeconds() - 10));
            yield* Effect.promise(() => writeFile(credentialsPath, stale));
            const checked = yield* Deferred.make<void>();
            onRead = () => Deferred.doneUnsafe(checked, Exit.void);
            const first = yield* Effect.forkChild(
              generate.pipe(
                Effect.provideService(Clock.Clock, signalling),
                Effect.provideService(Scheduler.MaxOpsBeforeYield, 1),
              ),
            );
            yield* Deferred.await(checked);
            for (let step = 0; step < steps; step++) {
              yield* Effect.yieldNow;
            }
            yield* Fiber.interrupt(first);
            yield* generate.pipe(Effect.timeout("2 seconds"));
          }
        }),
      ),
      fetch,
      {},
    );
    // Sixty rounds of refreshes with real file writes: seconds on a slow machine.
  }, 30_000);

  it("refreshes a linked credentials file in its target, under one lock for every alias", async () => {
    const target = join(configDirectory, "credentials", "linked-target.json");
    const link = join(configDirectory, "linked-alias.json");
    await mkdir(join(configDirectory, "credentials"), { recursive: true, mode: 0o700 });
    await writeFile(target, JSON.stringify(tokens("access-1", nowSeconds() - 10)), { mode: 0o600 });
    await symlink(target, link);
    const at = (credentialsPath: string) =>
      userOAuth({
        authentication: {
          type: "user_oauth",
          client_id: "client-from-profile",
          credentials_path: credentialsPath,
        },
      });
    const viaLink = await writeProfile(at(link), undefined);
    const direct = await writeProfile(at(target), undefined);
    const { model, token, fetch } = upstream(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ access_token: "access-2", expires_in: 3_600 });
    });
    // Two Sessions, so only the lock can keep them from refreshing twice.
    await Promise.all([generate(viaLink.name, fetch), generate(direct.name, fetch)]);
    expect(token).toHaveLength(1);
    expect(authorizations(model)).toEqual(["Bearer access-2", "Bearer access-2"]);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8")).access_token).toBe("access-2");
  });

  it("uses a token another process rotated between requests", async () => {
    const { name, credentialsPath } = await writeProfile(
      userOAuth(),
      tokens("access-1", nowSeconds() + 3_600),
    );
    const { model, token, fetch } = upstream();
    await run(
      Effect.gen(function* () {
        yield* LanguageModel.generateText({ prompt: "a" });
        yield* Effect.promise(() =>
          writeFile(
            credentialsPath,
            JSON.stringify(tokens("access-rotated", nowSeconds() + 3_600)),
          ),
        );
        yield* LanguageModel.generateText({ prompt: "b" });
      }).pipe(Effect.provide(layerOf(name))),
      fetch,
      {},
    );
    expect(authorizations(model)).toEqual(["Bearer access-1", "Bearer access-rotated"]);
    expect(token).toEqual([]);
  });

  it("fails closed when the profile is pointed at another host during a Session", async () => {
    const { name, credentialsPath } = await writeProfile(
      userOAuth({ base_url: "https://a.test" }),
      tokens("access-a", nowSeconds() + 3_600),
    );
    const sent: Array<readonly [string, string | null]> = [];
    const fetch = fakeFetch(
      (request) => {
        sent.push([new URL(request.url).origin, request.headers.get("authorization")]);
        return Response.json(message([{ type: "text", text: "ok" }]));
      },
      ["https://a.test", "https://b.test"],
    );
    const error = await run(
      Effect.gen(function* () {
        yield* LanguageModel.generateText({ prompt: "a" });
        // Signed in again for another host: its token must reach neither host from this Session.
        yield* Effect.promise(async () => {
          await writeFile(
            configPath(name),
            JSON.stringify(userOAuth({ base_url: "https://b.test" })),
          );
          await writeFile(
            credentialsPath,
            JSON.stringify(tokens("access-b", nowSeconds() + 3_600)),
          );
        });
        return yield* Effect.flip(LanguageModel.generateText({ prompt: "b" }));
      }).pipe(Effect.provide(layerOf(name, {}))),
      fetch,
      {},
    );
    expect(sent).toEqual([["https://a.test", "Bearer access-a"]]);
    expect(error.message).toContain(
      `The Anthropic profile "${name}" at ${configPath(name)} changed while this Session was running; restart the Session to use it.`,
    );
  });

  // A named pipe stands in for the credentials file, so the test writes them only once the
  // Session has read the config and opened the file; Windows has no named pipes of this kind.
  it.skipIf(!posix)(
    "fails closed when the profile is signed in for another host while its credentials are read",
    async () => {
      const { name, credentialsPath } = await writeProfile(
        userOAuth({ base_url: "https://a.test" }),
        tokens("access-a", nowSeconds() + 3_600),
      );
      const mkfifo = (process.env.PATH ?? "")
        .split(delimiter)
        .map((entry) => join(entry, "mkfifo"))
        .find((path) => existsSync(path));
      expect(mkfifo).toBeDefined();
      const sent: Array<readonly [string, string | null]> = [];
      const fetch = fakeFetch(
        (request) => {
          sent.push([new URL(request.url).origin, request.headers.get("authorization")]);
          return Response.json(message([{ type: "text", text: "ok" }]));
        },
        ["https://a.test", "https://b.test"],
      );
      let answered: Promise<void> = Promise.resolve();
      try {
        const error = await run(
          Effect.gen(function* () {
            yield* LanguageModel.generateText({ prompt: "a" });
            yield* Effect.promise(async () => {
              const pipe = `${credentialsPath}.pipe`;
              await promisify(execFile)(mkfifo!, ["-m", "600", pipe]);
              await rename(pipe, credentialsPath);
              // Opening the pipe waits for the Session to open it, after it read the config: `ant`
              // then signs in for another host.
              answered = (async () => {
                const writer = await open(credentialsPath, "w");
                try {
                  await writeFile(
                    configPath(name),
                    JSON.stringify(userOAuth({ base_url: "https://b.test" })),
                  );
                  await writer.writeFile(JSON.stringify(tokens("access-b", nowSeconds() + 3_600)));
                } finally {
                  await writer.close();
                }
              })();
            });
            return yield* Effect.flip(LanguageModel.generateText({ prompt: "b" }));
          }).pipe(Effect.provide(layerOf(name, {}))),
          fetch,
          {},
        );
        await answered;
        expect(sent).toEqual([["https://a.test", "Bearer access-a"]]);
        expect(error.message).toContain(
          `The Anthropic profile "${name}" at ${configPath(name)} changed while this Session was running; restart the Session to use it.`,
        );
      } finally {
        // Releases a writer still waiting for a reader, should the Session have stopped early.
        await (await open(credentialsPath, constants.O_RDONLY | constants.O_NONBLOCK)).close();
        await answered.catch(() => undefined);
      }
    },
  );

  it("does not recreate credentials signed out during a refresh", async () => {
    const { name, credentialsPath } = await writeProfile(
      userOAuth(),
      tokens("access-1", nowSeconds() - 10),
    );
    const { model, token, fetch } = upstream(async () => {
      await rm(credentialsPath);
      return Response.json({ access_token: "access-2", expires_in: 3_600, refresh_token: "r-2" });
    });
    const error = await failure(name, fetch);
    expect(token).toHaveLength(1);
    expect(model).toEqual([]);
    expect(error.message).toContain(
      `The Anthropic profile "${name}" is signed out. Sign in again: run \`ant auth login --profile=${name}\`.`,
    );
    await expect(stat(credentialsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [
      "succeeded",
      () => Response.json({ access_token: "access-2", expires_in: 3_600, refresh_token: "r-2" }),
    ],
    ["was rejected", () => Response.json({ error: "invalid_grant" }, { status: 400 })],
  ] as const)(
    "keeps and uses credentials signed in again during a refresh whose grant %s",
    async (_, reply) => {
      const { name, credentialsPath } = await writeProfile(
        userOAuth(),
        tokens("access-1", nowSeconds() - 10),
      );
      const newer = tokens("access-new", nowSeconds() + 3_600, { refresh_token: "refresh-new" });
      // The exchange is answered only once the credentials have been replaced.
      const { model, token, fetch } = upstream(async () => {
        await writeFile(credentialsPath, JSON.stringify(newer));
        return reply();
      });
      await generate(name, fetch);
      expect(token).toHaveLength(1);
      expect(authorizations(model)).toEqual(["Bearer access-new"]);
      expect(JSON.parse(await readFile(credentialsPath, "utf8"))).toEqual(newer);
    },
  );

  it("fails closed when the credentials link is removed or pointed elsewhere during a Session", async () => {
    const credentials = join(configDirectory, "credentials");
    await mkdir(credentials, { recursive: true, mode: 0o700 });
    const target = join(await realpath(credentials), "moving-target.json");
    const other = join(await realpath(credentials), "moving-other.json");
    const link = join(configDirectory, "moving-link.json");
    const fresh = (access: string) => JSON.stringify(tokens(access, nowSeconds() + 3_600));
    await writeFile(target, fresh("access-target"), { mode: 0o600 });
    await writeFile(other, fresh("access-other"), { mode: 0o600 });
    const { name } = await writeProfile(
      userOAuth({
        authentication: {
          type: "user_oauth",
          client_id: "client-from-profile",
          credentials_path: link,
        },
      }),
      undefined,
    );
    const session = (change: () => Promise<void>) =>
      Effect.gen(function* () {
        yield* LanguageModel.generateText({ prompt: "a" });
        yield* Effect.promise(change);
        return yield* Effect.flip(LanguageModel.generateText({ prompt: "b" }));
      }).pipe(Effect.provide(layerOf(name)));
    const { model, token, fetch } = upstream();

    await symlink(target, link);
    const removed = await run(
      session(() => rm(link)),
      fetch,
      {},
    );
    expect(removed.message).toContain(
      `The Anthropic profile "${name}" is signed out. Sign in again: run \`ant auth login --profile=${name}\`.`,
    );

    await symlink(target, link);
    const retargeted = await run(
      session(async () => {
        await rm(link);
        await symlink(other, link);
      }),
      fetch,
      {},
    );
    expect(retargeted.message).toContain(
      `The Anthropic profile "${name}" at ${configPath(name)} changed while this Session was running; restart the Session to use it.`,
    );
    expect(authorizations(model)).toEqual(["Bearer access-target", "Bearer access-target"]);
    expect(token).toEqual([]);
  });

  /** Anthropic's answer to a bearer token it does not accept. */
  const unauthorized = () =>
    Response.json(
      { type: "error", error: { type: "authentication_error", message: "Invalid bearer token" } },
      { status: 401 },
    );

  /** Rejects the first Model request after `beforeRejecting`, then answers; records both sides. */
  const rejectingOnce = (
    beforeRejecting: () => Promise<void>,
    tokenReply: () => Response = () =>
      Response.json({ access_token: "access-2", expires_in: 3_600, refresh_token: "refresh-2" }),
  ) => {
    const model: Array<Headers> = [];
    const token: Array<Schema.Json> = [];
    const fetch = fakeFetch(async (request) => {
      if (new URL(request.url).pathname === "/v1/oauth/token") {
        token.push(Schema.decodeUnknownSync(Schema.Json)(await request.json()));
        return tokenReply();
      }
      model.push(request.headers);
      if (model.length > 1) {
        return Response.json(message([{ type: "text", text: "ok" }]));
      }
      await beforeRejecting();
      return unauthorized();
    });
    return { model, token, fetch };
  };

  it("retries a rejected token with a fresh one another process put in its place, without refreshing", async () => {
    const { name, credentialsPath } = await writeProfile(
      userOAuth(),
      tokens("access-1", nowSeconds() + 3_600),
    );
    const { model, token, fetch } = rejectingOnce(() =>
      writeFile(credentialsPath, JSON.stringify(tokens("access-other", nowSeconds() + 3_600))),
    );
    await generate(name, fetch);
    expect(authorizations(model)).toEqual(["Bearer access-1", "Bearer access-other"]);
    expect(token).toEqual([]);
  });

  it("refreshes through the fetch of the request, not the one the Model was built with", async () => {
    const { name } = await writeProfile(userOAuth(), tokens("access-1", nowSeconds() + 3_600));
    const built = upstream();
    const requested = rejectingOnce(async () => {});
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const model = yield* Layer.build(layerOf(name));
          yield* LanguageModel.generateText({ prompt: "Hi" }).pipe(
            Effect.provideContext(model),
            Effect.provideService(FetchHttpClient.Fetch, requested.fetch),
          );
        }),
      ),
      built.fetch,
      {},
    );
    expect(built.token).toEqual([]);
    expect(requested.token).toHaveLength(1);
    expect(authorizations(requested.model)).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  it("streams with a refreshed token when the stream is refused before it opens", async () => {
    const { name } = await writeProfile(userOAuth(), tokens("access-1", nowSeconds() + 3_600));
    const model: Array<Headers> = [];
    const fetch = fakeFetch((request) => {
      if (new URL(request.url).pathname === "/v1/oauth/token") {
        return Response.json({ access_token: "access-2", expires_in: 3_600 });
      }
      model.push(request.headers);
      return model.length === 1 ? unauthorized() : documentedStream();
    });
    const parts = await run(
      Stream.runCollect(LanguageModel.streamText({ prompt: "Hi" })).pipe(
        Effect.provide(layerOf(name)),
      ),
      fetch,
      {},
    );
    expect(authorizations(model)).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(textDeltas([...parts])).toEqual(["Hello", "!"]);
  });

  it("refreshes a rejected token when the one put in its place has expired", async () => {
    const { name, credentialsPath } = await writeProfile(
      userOAuth(),
      tokens("access-1", nowSeconds() + 3_600),
    );
    const { model, token, fetch } = rejectingOnce(() =>
      writeFile(credentialsPath, JSON.stringify(tokens("access-expired", nowSeconds() - 10))),
    );
    await generate(name, fetch);
    expect(authorizations(model)).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(token).toHaveLength(1);
  });

  it("keeps a new grant but returns the rejection when the refresh gives back the rejected token", async () => {
    const { name, credentialsPath } = await writeProfile(
      userOAuth(),
      tokens("access-1", nowSeconds() + 3_600),
    );
    const { model, token, fetch } = rejectingOnce(
      async () => {},
      () =>
        Response.json({ access_token: "access-1", expires_in: 3_600, refresh_token: "refresh-2" }),
    );
    const error = await failure(name, fetch);
    expect(authorizations(model)).toEqual(["Bearer access-1"]);
    expect(token).toHaveLength(1);
    expect(error).toMatchObject({
      reason: { _tag: "AuthenticationError", http: { response: { status: 401 } } },
    });
    expect(JSON.parse(await readFile(credentialsPath, "utf8"))).toMatchObject({
      access_token: "access-1",
      refresh_token: "refresh-2",
    });
  });

  it("refreshes a rejected token that the refresh for another rejected token answers with", async () => {
    const { name, credentialsPath } = await writeProfile(
      userOAuth(),
      tokens("access-A", nowSeconds() + 3_600),
    );
    const lock = `${credentialsPath}.lock`;
    const model: Array<Headers> = [];
    const token: Array<Schema.Json> = [];
    let answerB = () => {};
    const rejectedB = new Promise<void>((resolve) => (answerB = resolve));
    const fetch = fakeFetch(async (request) => {
      if (new URL(request.url).pathname === "/v1/oauth/token") {
        token.push(Schema.decodeUnknownSync(Schema.Json)(await request.json()));
        return Response.json({ access_token: "access-2", expires_in: 3_600 });
      }
      model.push(request.headers);
      const authorization = request.headers.get("authorization");
      if (authorization === "Bearer access-A") {
        // Another process, still holding the lock, has put B in A's place.
        await writeFile(lock, "");
        const b = tokens("access-B", nowSeconds() + 3_600, { refresh_token: "refresh-B" });
        await writeFile(credentialsPath, JSON.stringify(b));
      }
      if (authorization === "Bearer access-B") {
        answerB();
      }
      return authorization === "Bearer access-2"
        ? Response.json(message([{ type: "text", text: "ok" }]))
        : unauthorized();
    });
    const second = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layerOf(name));
          const generate = LanguageModel.generateText({ prompt: "a" }).pipe(
            Effect.provideContext(context),
          );
          // The first request's refresh, for A, signals when it starts waiting for the lock.
          const clock = yield* Clock.Clock;
          const waiting = yield* Deferred.make<void>();
          const signalling: Clock.Clock = {
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
            currentTimeMillis: clock.currentTimeMillis,
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            currentTimeNanos: clock.currentTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            sleep: (duration) =>
              Effect.andThen(Deferred.succeed(waiting, undefined), clock.sleep(duration)),
          };
          const first = yield* Effect.forkChild(
            Effect.exit(generate.pipe(Effect.provideService(Clock.Clock, signalling))),
          );
          yield* Deferred.await(waiting);
          // The second request sends B, and its 401 joins the refresh for A.
          const second = yield* Effect.forkChild(Effect.exit(generate));
          yield* Effect.promise(() => rejectedB);
          // Time for that 401 to reach the refresh in flight before the lock is released.
          yield* Effect.sleep("50 millis");
          yield* Effect.promise(() => rm(lock));
          yield* Fiber.join(first);
          return yield* Fiber.join(second);
        }),
      ),
      fetch,
      {},
    );
    expect(token).toMatchObject([{ refresh_token: "refresh-B" }]);
    expect(Exit.isSuccess(second)).toBe(true);
    expect(authorizations(model).slice(0, 2)).toEqual(["Bearer access-A", "Bearer access-B"]);
    expect(authorizations(model)).toContain("Bearer access-2");
  });

  it("joins a refresh in flight for another rejected token, then refreshes its own when that answers with it", async () => {
    const { name, credentialsPath } = await writeProfile(
      userOAuth(),
      tokens("access-B", nowSeconds() + 3_600, { refresh_token: "refresh-B" }),
    );
    // Another process holds the lock, having put B in the place of A.
    const lock = `${credentialsPath}.lock`;
    await writeFile(lock, "");
    const exchanged: Array<Schema.Json> = [];
    const tokenClient = HttpClient.make((request) =>
      Effect.sync(() => {
        if (Predicate.isTagged(request.body, "Uint8Array")) {
          exchanged.push(JSON.parse(new TextDecoder().decode(request.body.body)));
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ access_token: "access-2", expires_in: 3_600 }),
        );
      }),
    );
    const accessToken = tokenSource(
      {
        name,
        directory: configDirectory,
        configPath: configPath(name),
        type: "user_oauth",
        credentialsPath: join(configDirectory, "credentials", `${name}.json`),
        clientId: "client-from-profile",
        workspaceId: undefined,
        baseUrl: testOrigin,
      },
      credentialsPath,
      `${testOrigin}/v1/oauth/token`,
    );
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const waiting = yield* Deferred.make<void>();
        const signalling: Clock.Clock = {
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
          currentTimeMillis: clock.currentTimeMillis,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          currentTimeNanos: clock.currentTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          // A's refresh first sleeps when it finds the lock held.
          sleep: (duration) =>
            Effect.andThen(Deferred.succeed(waiting, undefined), clock.sleep(duration)),
        };
        const first = yield* Effect.forkChild(
          accessToken("access-A").pipe(Effect.provideService(Clock.Clock, signalling)),
        );
        yield* Deferred.await(waiting);
        // Nothing on the way to joining waits, so B has joined A's refresh once this returns.
        const second = yield* Effect.forkChild(accessToken("access-B"), {
          startImmediately: true,
        });
        yield* Effect.promise(() => rm(lock));
        return [yield* Fiber.join(first), yield* Fiber.join(second)];
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, tokenClient),
        Effect.provide(platformLayer),
      ),
    );
    expect(first).toBe("access-B");
    expect(second).toBe("access-2");
    expect(exchanged).toMatchObject([{ refresh_token: "refresh-B" }]);
  });

  it("refuses to send a token anywhere but https or this machine, naming the setting, not its value", async () => {
    const attempts: Array<string> = [];
    const fetch = answerEveryOrigin((request) => {
      attempts.push(request.url);
      throw new Error("no request may be sent");
    });
    const fresh = tokens("access-1", nowSeconds() + 3_600);
    const rule =
      "must be an https URL (http only to this machine) with no user name, password, query or fragment.";
    const inProfile = (name: string) =>
      `Cannot send the tokens of the Anthropic profile "${name}": \`base_url\` in ${configPath(name)} ${rule}`;
    const inOption = (name: string) =>
      `Cannot send the tokens of the Anthropic profile "${name}": the \`baseUrl\` option of \`anthropic()\` ${rule}`;
    const refused = async (
      base: { readonly profile?: string; readonly option?: string },
      expected: (name: string) => string,
    ) => {
      const { name } = await writeProfile(
        userOAuth(base.profile === undefined ? {} : { base_url: base.profile }),
        fresh,
      );
      const error = await provisioning(
        name,
        fetch,
        base.option === undefined ? {} : { baseUrl: base.option },
      );
      expect(error).toMatchObject({ _tag: "UnusableProfileError", message: expected(name) });
      for (const shown of renderings(error)) {
        expect(shown).not.toContain("SENTINEL");
      }
    };
    await refused({ profile: "http://test.invalid" }, inProfile);
    await refused({ option: "http://test.invalid" }, inOption);
    await refused({ profile: "not a url" }, inProfile);
    // A slash alone names no host: it is not the default host.
    await refused({ profile: "/" }, inProfile);
    await refused({ option: "/" }, inOption);
    // The profile's own host refreshes its tokens, whatever host the Model requests go to.
    await refused({ profile: "http://test.invalid", option: "https://test.invalid" }, inProfile);
    await refused({ profile: "https://SENTINEL-USER:SENTINEL-PASSWORD@test.invalid" }, inProfile);
    await refused({ option: "https://test.invalid/?key=SENTINEL-QUERY" }, inOption);
    await refused({ profile: "https://test.invalid/#SENTINEL-FRAGMENT" }, inProfile);
    expect(attempts).toEqual([]);
  });

  it("sends the refresh token to Anthropic's host, not the baseUrl option's, when the profile names none", async () => {
    const { name } = await writeProfile(anthropicIssued, tokens("access-1", nowSeconds() - 10));
    const sent: Array<string> = [];
    const fetch = fakeFetch(
      (request) => {
        const { origin, pathname } = new URL(request.url);
        sent.push(`${origin}${pathname} ${request.headers.get("authorization")}`);
        return pathname === "/v1/oauth/token"
          ? Response.json({ access_token: "access-2", expires_in: 3_600 })
          : Response.json(message([{ type: "text", text: "ok" }]));
      },
      [testOrigin, "https://api.anthropic.com"],
    );
    await generate(name, fetch);
    expect(sent).toEqual([
      "https://api.anthropic.com/v1/oauth/token null",
      `${testOrigin}/v1/messages Bearer access-2`,
    ]);
  });

  it("treats a token as static when the profile records no client id", async () => {
    const noClient = userOAuth({ authentication: { type: "user_oauth" } });
    const fresh = await writeProfile(noClient, tokens("access-1", nowSeconds() + 3_600));
    const { model, token, fetch } = upstream();
    await generate(fresh.name, fetch);
    expect(authorizations(model)).toEqual(["Bearer access-1"]);

    const expired = await writeProfile(noClient, tokens("access-1", nowSeconds() - 10));
    expect(await failure(expired.name, fetch)).toMatchObject({
      _tag: "UnusableProfileError",
      // `ant auth login` keeps an existing config, so signing in again would not add a client id.
      message: `The Anthropic sign-in of profile "${expired.name}" has expired and cannot be refreshed: the profile records no client id. Repair ${configPath(expired.name)}, or remove that file and sign in again (run \`ant auth login --profile=${expired.name}\`), or select another profile with the \`profile\` option of \`anthropic()\`.`,
    });
    const noRefresh = await writeProfile(
      userOAuth(),
      tokens("access-1", nowSeconds() - 10, { refresh_token: "" }),
    );
    expect(await failure(noRefresh.name, fetch)).toMatchObject({
      message: `The Anthropic sign-in of profile "${noRefresh.name}" has expired and cannot be refreshed: the profile records no refresh token. Sign in again: run \`ant auth login --profile=${noRefresh.name}\`.`,
    });
    expect(token).toEqual([]);
    expect(model).toHaveLength(1);
  });

  it("asks to sign in again only when the token endpoint rejects the grant", async () => {
    const { name } = await writeProfile(
      userOAuth(),
      tokens("access-1", nowSeconds() - 10, { refresh_token: "SENTINEL-REFRESH" }),
    );
    const { model, fetch } = upstream(() =>
      Response.json(
        { error: "invalid_grant", error_description: "SENTINEL-REFRESH was revoked" },
        { status: 400 },
      ),
    );
    const error = await failure(name, fetch);
    expect(error.message).toContain(
      `The Anthropic sign-in of profile "${name}" expired or was revoked (token refresh failed: HTTP 400; invalid_grant). Sign in again: run \`ant auth login --profile=${name}\`.`,
    );
    expect(error).toMatchObject({ reason: { _tag: "AuthenticationError" } });
    for (const shown of renderings(error)) {
      expect(shown).not.toContain("SENTINEL");
    }
    expect(model).toEqual([]);
  });

  it.each([429, 503])(
    "reports a %d from the token endpoint as a temporary failure",
    async (status) => {
      const { name } = await writeProfile(
        userOAuth(),
        tokens("access-1", nowSeconds() - 10, { refresh_token: "SENTINEL-REFRESH" }),
      );
      const { model, fetch } = upstream(() =>
        Response.json(
          { error: "SENTINEL-REFRESH", error_description: "SENTINEL-REFRESH is busy" },
          { status },
        ),
      );
      const error = await failure(name, fetch);
      expect(error.message).toContain(
        `The Anthropic sign-in of profile "${name}" could not be refreshed right now (HTTP ${status}); try again later.`,
      );
      expect(error.message).not.toContain("Sign in again");
      expect(error).toMatchObject({ reason: { _tag: "InternalProviderError", isRetryable: true } });
      for (const shown of renderings(error)) {
        expect(shown).not.toContain("SENTINEL");
      }
      expect(model).toEqual([]);
    },
  );

  it.each([
    [
      "an invalid response",
      () => Response.json({ access_token: "SENTINEL-ACCESS", token_type: "SENTINEL-ACCESS" }),
    ],
    [
      "a token type other than Bearer",
      () =>
        Response.json({
          access_token: "SENTINEL-ACCESS",
          expires_in: 3_600,
          token_type: "SENTINEL-ACCESS",
        }),
    ],
    [
      "HTTP 307",
      // A redirect is no answer from the token endpoint, whatever its body claims; a followed 307
      // would resend the grant.
      () =>
        Response.json(
          { error: "invalid_grant" },
          { status: 307, headers: { location: "https://test.invalid/x" } },
        ),
    ],
    ["HTTP 400; invalid_client", () => Response.json({ error: "invalid_client" }, { status: 400 })],
  ] as const)(
    "reports a token endpoint answering with %s as a broken endpoint, not a lost sign-in",
    async (what, reply) => {
      const { name } = await writeProfile(userOAuth(), tokens("access-1", nowSeconds() - 10));
      const { model, token, fetch } = upstream(reply);
      const error = await failure(name, fetch);
      expect(token.map((request) => request.redirect)).toEqual(["manual"]);
      expect(error.message).toContain(
        `The Anthropic token endpoint ${baseUrl}/v1/oauth/token did not refresh the sign-in of profile "${name}" (${what}). Check \`base_url\` and \`authentication.client_id\` in ${configPath(name)}, or select another profile with the \`profile\` option of \`anthropic()\`.`,
      );
      expect(error.message).not.toContain("Sign in again");
      expect(error).toMatchObject({ reason: { _tag: "UnknownError" } });
      for (const shown of renderings(error)) {
        expect(shown).not.toContain("SENTINEL");
      }
      expect(model).toEqual([]);
    },
  );

  it("names what is wrong with a profile it cannot use, and how to fix it", async () => {
    const { fetch, model } = upstream();
    const remove = (name: string) =>
      `remove that file and sign in again (run \`ant auth login --profile=${name}\`)`;
    const another = "select another profile with the `profile` option of `anthropic()`";
    const federation = await writeProfile(
      { authentication: { type: "oidc_federation", federation_rule_id: "fdrl_1" } },
      undefined,
    );
    expect(await provisioning(federation.name, fetch)).toMatchObject({
      _tag: "UnusableProfileError",
      message: `The Anthropic profile "${federation.name}" at ${configPath(federation.name)} uses authentication type "oidc_federation"; Mitome reads only the Claude Console sign-in ("user_oauth") that \`ant auth login\` writes. Select another profile with the \`profile\` option of \`anthropic()\`, or ${remove(federation.name)}.`,
    });
    const malformed = await writeProfile(userOAuth(), tokens("access-1", nowSeconds() + 3_600));
    await writeFile(configPath(malformed.name), "{");
    expect(await provisioning(malformed.name, fetch)).toMatchObject({
      message: `The Anthropic profile "${malformed.name}" at ${configPath(malformed.name)} is not a valid profile. Repair that file, or ${remove(malformed.name)}, or ${another}.`,
    });
    if (posix) {
      const shared = await writeProfile(
        userOAuth(),
        tokens("access-1", nowSeconds() + 3_600),
        0o644,
      );
      expect(await provisioning(shared.name, fetch)).toMatchObject({
        message: `The Anthropic credentials file ${shared.credentialsPath} can be read or written by other users (mode 0o644); make it readable and writable by its owner only (mode 600).`,
      });
    }
    // Permissions do not stop root, and Windows has none to change.
    if (posix && process.getuid?.() !== 0) {
      const locked = await writeProfile(userOAuth(), tokens("access-1", nowSeconds() + 3_600));
      await chmod(configPath(locked.name), 0o000);
      expect(await provisioning(locked.name, fetch)).toMatchObject({
        message: `Could not read the Anthropic profile "${locked.name}" at ${configPath(locked.name)} (EACCES): give your user read permission on it.`,
      });
      const unreadable = await writeProfile(
        userOAuth(),
        tokens("access-1", nowSeconds() + 3_600),
        0o000,
      );
      expect(await provisioning(unreadable.name, fetch)).toMatchObject({
        message: `Could not read the Anthropic credentials file ${unreadable.credentialsPath} of profile "${unreadable.name}" (EACCES): make it readable and writable by its owner only (mode 600).`,
      });
    }
    const corrupt = await writeProfile(userOAuth(), { type: "oauth_token" });
    expect(await provisioning(corrupt.name, fetch)).toMatchObject({
      message: `The Anthropic credentials file ${corrupt.credentialsPath} of profile "${corrupt.name}" is not valid. Sign in again: run \`ant auth login --profile=${corrupt.name}\`.`,
    });
    expect(await provisioning("../escape", fetch)).toMatchObject({
      message:
        'Anthropic profile name "../escape" is invalid: use letters, digits, "_", "." and "-".',
    });
    // A profile `ant auth logout` signed out keeps its config but no credentials.
    const signedOut = await writeProfile(userOAuth(), undefined);
    expect(await provisioning(signedOut.name, fetch)).toMatchObject({
      _tag: "MissingCredentialError",
      message: `Environment variable ${unsetKey} is not set or empty. Set it to an API key, or sign in to the Claude Console: run \`ant auth login --profile=${signedOut.name}\`.`,
    });
    expect(model).toEqual([]);
  });
});

// The fake `ant` is a POSIX shell script; Windows cannot run it, so these tests are skipped there.
describe.skipIf(process.platform === "win32")("anthropic authenticate", () => {
  /**
   * Runs `authenticate` with a fake `ant` as the only program on PATH, recording each call's
   * arguments one element at a time.
   */
  const authenticateWith = async (
    options: Partial<Parameters<typeof authenticate>[0]> & {
      readonly operation: "login" | "logout";
    },
  ) => {
    const bin = await mkdtemp(join(tmpdir(), "mitome-anthropic-bin-"));
    const log = join(bin, "arguments.log");
    await writeFile(
      join(bin, "ant"),
      `#!/bin/sh\nprintf '%s|' "$@" >> "$MITOME_TEST_ANT_LOG"\necho >> "$MITOME_TEST_ANT_LOG"\n`,
      { mode: 0o755 },
    );
    const output: Array<string> = [];
    const path = process.env.PATH;
    process.env.PATH = bin;
    process.env.MITOME_TEST_ANT_LOG = log;
    try {
      const outcome = await Effect.runPromise(
        authenticate({
          stateDirectory: home,
          input: Effect.succeed(undefined),
          output: (text) => void output.push(text),
          ...options,
        }).pipe(Effect.match({ onSuccess: () => undefined, onFailure: (error) => error })),
      );
      const calls = await readFile(log, "utf8").then(
        (text) =>
          text
            .split("\n")
            .filter(Boolean)
            .map((call) => call.split("|").slice(0, -1)),
        (): Array<Array<string>> => [],
      );
      return { outcome, calls, output: output.join("") };
    } finally {
      process.env.PATH = path;
      delete process.env.MITOME_TEST_ANT_LOG;
      await rm(bin, { recursive: true, force: true });
    }
  };

  it("runs ant for the Provider's profile, without a browser when asked, saying what login changes", async () => {
    const login = await authenticateWith({
      operation: "login",
      profile: "work",
      openBrowser: false,
    });
    expect(login.outcome).toBeUndefined();
    expect(login.calls).toEqual([["auth", "login", "--profile=work", "--no-browser"]]);
    expect(login.output).toBe(
      '`ant auth login --profile=work` also makes "work" the active profile of `ant`, so other Anthropic tools that name no profile will use it; switch back with `ant profile activate <name>`.\n',
    );
    const logout = await authenticateWith({ operation: "logout", profile: "work" });
    expect(logout.calls).toEqual([["auth", "logout", "--profile=work"]]);
    expect(logout.output).toBe("");
    expect((await authenticateWith({ operation: "login" })).calls).toEqual([
      ["auth", "login", "--profile=mitome"],
    ]);
  });

  // `ant` stops parsing flags when any argument is `__complete` (`cmd/ant/main.go`), and a
  // separate profile argument starting with `-` could read as a flag.
  it.each(["__complete", "--all", "work"])(
    "names the profile %s to ant in one argument, signing in and out of that profile",
    async (profile) => {
      for (const operation of ["login", "logout"] as const) {
        expect((await authenticateWith({ operation, profile })).calls).toEqual([
          ["auth", operation, `--profile=${profile}`],
        ]);
      }
    },
  );

  // Runs a fake `ant` until it has written its PID beside itself, interrupts the sign-in, and
  // returns that PID.
  const interruptAnt = async (
    onTerm: string,
    around: (run: Effect.Effect<void, Error>) => Effect.Effect<void, Error> = (run) => run,
  ) => {
    const bin = await mkdtemp(join(tmpdir(), "mitome-anthropic-bin-"));
    await writeFile(
      join(bin, "ant"),
      `#!/bin/sh\n${onTerm}\necho $$ > "$0.pid"\nwhile :; do sleep 0.01; done\n`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    const fiber = Effect.runFork(
      around(
        authenticate({
          operation: "logout",
          stateDirectory: home,
          input: Effect.succeed(undefined),
          output: () => {},
        }),
      ),
    );
    try {
      let pid: number | undefined;
      for (let attempt = 0; attempt < 500 && pid === undefined; attempt++) {
        const text = await readFile(join(bin, "ant.pid"), "utf8").catch(() => "");
        if (text.endsWith("\n")) {
          pid = Number(text);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(pid).toBeDefined();
      await Effect.runPromise(Fiber.interrupt(fiber));
      return pid!;
    } finally {
      // Also stops a fake that never reported its PID.
      await Effect.runPromise(Fiber.interrupt(fiber));
      process.env.PATH = path;
      await rm(bin, { recursive: true, force: true });
    }
  };
  const gone = expect.objectContaining({ code: "ESRCH" });

  it("waits for ant to exit when it is interrupted", async () => {
    // The fake takes a while to exit after SIGTERM, as a program cleaning up does.
    const pid = await interruptAnt("trap 'sleep 0.2; exit 143' TERM");
    expect(() => process.kill(pid, 0)).toThrow(gone);
  });

  it("kills an ant that ignores the request to stop", async () => {
    const pid = await interruptAnt("trap '' TERM", (run) =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        // The bound on stopping is the only sleep on this path, so it has passed at once.
        return yield* run.pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
            currentTimeMillis: clock.currentTimeMillis,
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            currentTimeNanos: clock.currentTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            sleep: () => Effect.void,
          }),
        );
      }),
    );
    expect(() => process.kill(pid, 0)).toThrow(gone);
  });

  it("names the signal that stopped ant", async () => {
    const bin = await mkdtemp(join(tmpdir(), "mitome-anthropic-bin-"));
    await writeFile(join(bin, "ant"), "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = bin;
    try {
      const error = await Effect.runPromise(
        Effect.flip(
          authenticate({
            operation: "logout",
            stateDirectory: home,
            input: Effect.succeed(undefined),
            output: () => {},
          }),
        ),
      );
      expect(error.message).toBe("ant auth logout --profile=mitome was stopped by SIGTERM.");
    } finally {
      process.env.PATH = path;
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("refuses an invalid profile name without running ant", async () => {
    const result = await authenticateWith({ operation: "logout", profile: "../escape" });
    expect(result.calls).toEqual([]);
    expect(result.outcome).toMatchObject({
      message:
        'Anthropic profile name "../escape" is invalid: use letters, digits, "_", "." and "-".',
    });
  });
});
