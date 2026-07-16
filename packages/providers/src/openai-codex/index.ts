// Adapted from Pi (MIT License). Copyright (c) 2025 Mario Zechner.
import { Effect, Layer, Stream } from "effect";
import { AiError, LanguageModel, Response, Tool } from "effect/unstable/ai";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { Sse } from "effect/unstable/encoding";
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  makeModel,
  resolveConfigDirectory,
  type CredentialDescriptor,
  type Model,
} from "@mitome/core";

const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const provider = "openai-codex";
const defaultTokenUrl = "https://auth.openai.com/oauth/token";

// Hand-maintained hints: the undocumented backend has no safe model-discovery API.
// Source: https://developers.openai.com/codex/models (verified 2026-07-15).
export type KnownModelId =
  | "gpt-5.3-codex-spark"
  | "gpt-5.4"
  | "gpt-5.4-mini"
  | "gpt-5.5"
  | "gpt-5.6"
  | "gpt-5.6-sol"
  | "gpt-5.6-terra"
  | "gpt-5.6-luna";
export type ModelId = KnownModelId | (string & {});

export type OAuthCredential = {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId: string;
};

type AuthFile = Record<string, unknown>;

type Input = () => Promise<string | undefined>;
type Output = (text: string) => void;

export interface LoginOptions {
  readonly configDirectory: string;
  readonly callbackPort?: number;
  readonly tokenUrl?: string;
  readonly openBrowser?: false | ((url: string) => void | Promise<void>);
  readonly input: Input;
  readonly output: Output;
}

export interface LogoutOptions {
  readonly configDirectory: string;
  readonly output?: Output;
}

export interface CodexOptions {
  /** Unofficial ChatGPT backend root; injectable for controlled transport fixtures. */
  readonly baseUrl?: string;
  /** Credential directory; defaults to XDG_CONFIG_HOME, Windows APPDATA, or Unix HOME. */
  readonly configDirectory?: string;
  /** OAuth token endpoint; injectable for controlled refresh fixtures. */
  readonly tokenUrl?: string;
}

/** Declares the single ChatGPT Credential used by a Codex Model. */
export const oauth = (): CredentialDescriptor => ({
  capability: { module: import.meta.url },
});

const providerError = (description: string) =>
  AiError.make({
    module: "OpenAI Codex",
    method: "streamText",
    reason: new AiError.UnknownError({ description }),
  });

const invalidOutput = (description: string) =>
  AiError.make({
    module: "OpenAI Codex",
    method: "streamText",
    reason: new AiError.InvalidOutputError({ description }),
  });

const networkError = (cause: unknown) =>
  providerError(cause instanceof Error ? cause.message : "Codex request failed");

const defaultConfigDirectory = (): string => {
  const directory = resolveConfigDirectory(process.env, process.platform);
  if (directory === undefined) {
    throw new Error(
      "Set XDG_CONFIG_HOME, APPDATA (on Windows), or HOME to locate Codex credentials.",
    );
  }
  return directory;
};

const contentFor = (
  content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>,
) =>
  typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");

const requestFor = (model: string, options: LanguageModel.ProviderOptions, sessionId: string) => {
  const system = options.prompt.content.find((message) => message.role === "system");
  const input: Array<Record<string, unknown>> = [];
  for (const message of options.prompt.content) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          input.push({
            type: "function_call_output",
            call_id: part.id,
            output: JSON.stringify(part.result),
          });
        }
      }
      continue;
    }
    const content = contentFor(message.content);
    if (message.role === "assistant") {
      if (content !== "") input.push({ role: "assistant", content });
      for (const part of message.content) {
        if (part.type === "tool-call") {
          input.push({
            type: "function_call",
            call_id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.params),
          });
        }
      }
      continue;
    }
    input.push({ role: "user", content });
  }
  return {
    model,
    store: false,
    stream: true,
    instructions:
      system === undefined ? "You are a helpful assistant." : contentFor(system.content),
    input,
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: sessionId,
    tool_choice: "auto",
    parallel_tool_calls: true,
    ...(options.tools.length === 0
      ? {}
      : {
          tools: options.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            ...(Tool.getDescription(tool) === undefined
              ? {}
              : { description: Tool.getDescription(tool) }),
            parameters: Tool.getJsonSchema(tool),
            strict: null,
          })),
        }),
  };
};

type Call = { readonly id: string; readonly name: string; arguments: string };
type StreamState = {
  readonly events: Array<string>;
  readonly parser: Sse.Parser;
  readonly calls: Map<string, Call>;
  readonly textIds: Set<string>;
  terminal: boolean;
};

const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
// The backend keys some events by item_id ("msg_…") and omits it on others
// (output_item.added carries only output_index), so output_index is the one
// key present on every per-item event — matching Pi's reference transport.
const itemKey = (event: Record<string, unknown>) =>
  typeof event.output_index === "number"
    ? String(event.output_index)
    : (string(event.item_id) ?? "output");

const decodeEvent = (state: StreamState, data: string): Array<Response.StreamPartEncoded> => {
  if (data === "[DONE]") return [];
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(data) as Record<string, unknown>;
  } catch {
    throw invalidOutput("Codex sent malformed SSE JSON");
  }
  const type = string(event.type);
  if (type === "error") {
    const error = record(event.error);
    throw providerError(string(error?.message) ?? string(event.message) ?? "Codex provider error");
  }
  if (type === "response.failed") {
    const response = record(event.response);
    const error = record(response?.error);
    throw providerError(string(error?.message) ?? "Codex response failed");
  }
  if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
    state.terminal = true;
    return [];
  }
  const key = itemKey(event);
  if (type === "response.output_item.added") {
    const item = record(event.item);
    if (item?.type === "message") {
      state.textIds.add(key);
      return [Response.makePart("text-start", { id: key })];
    }
    if (item?.type === "function_call") {
      const id = string(item.call_id) ?? string(item.id);
      const name = string(item.name);
      if (id === undefined || name === undefined)
        throw invalidOutput("Codex sent an incomplete Tool call");
      const call = { id, name, arguments: "" };
      state.calls.set(key, call);
      // Argument deltas may arrive keyed by item_id instead of output_index.
      const itemId = string(item.id);
      if (itemId !== undefined) state.calls.set(itemId, call);
      return [Response.makePart("tool-params-start", { id, name, providerExecuted: false })];
    }
    return [];
  }
  if (type === "response.output_text.delta") {
    const delta = string(event.delta);
    if (delta === undefined || !state.textIds.has(key))
      throw invalidOutput("Codex sent text without a message item");
    return [Response.makePart("text-delta", { id: key, delta })];
  }
  if (type === "response.function_call_arguments.delta") {
    const call = state.calls.get(key);
    const delta = string(event.delta);
    if (call === undefined || delta === undefined)
      throw invalidOutput("Codex sent arguments without a Tool call");
    call.arguments += delta;
    return [Response.makePart("tool-params-delta", { id: call.id, delta })];
  }
  if (type === "response.function_call_arguments.done") {
    const call = state.calls.get(key);
    const arguments_ = string(event.arguments);
    if (call === undefined || arguments_ === undefined)
      throw invalidOutput("Codex sent final arguments without a Tool call");
    const delta = arguments_.startsWith(call.arguments)
      ? arguments_.slice(call.arguments.length)
      : "";
    call.arguments = arguments_;
    return delta === "" ? [] : [Response.makePart("tool-params-delta", { id: call.id, delta })];
  }
  if (type === "response.output_item.done") {
    const item = record(event.item);
    if (item?.type === "message")
      return state.textIds.delete(key) ? [Response.makePart("text-end", { id: key })] : [];
    if (item?.type === "function_call") {
      const call = state.calls.get(key) ?? state.calls.get(string(item.id) ?? "");
      if (call === undefined) throw invalidOutput("Codex completed an unknown Tool call");
      const arguments_ = string(item.arguments) ?? call.arguments;
      let params: unknown;
      try {
        params = Tool.unsafeSecureJsonParse(arguments_ || "{}");
      } catch {
        throw invalidOutput(`Invalid JSON arguments for Tool ${call.name}`);
      }
      state.calls.delete(key);
      return [
        Response.makePart("tool-params-end", { id: call.id }),
        Response.makePart("tool-call", {
          id: call.id,
          name: call.name,
          params,
          providerExecuted: false,
        }),
      ];
    }
  }
  return [];
};

const decodeStream = <R>(
  stream: Stream.Stream<Uint8Array, AiError.AiError, R>,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError, R> =>
  // Suspend so a re-run (e.g. a future retry) gets fresh parser/terminal state.
  Stream.suspend(() => {
    const events: Array<string> = [];
    const state: StreamState = {
      events,
      parser: Sse.makeParser((event) => {
        if (event._tag === "Event") events.push(event.data);
      }),
      calls: new Map(),
      textIds: new Set(),
      terminal: false,
    };
    return stream.pipe(
      Stream.decodeText,
      Stream.mapAccumArrayEffect(
        () => state,
        (current, chunk) =>
          Effect.try({
            try: () => {
              for (const value of chunk) current.parser.feed(value);
              return [
                current,
                current.events.splice(0).flatMap((event) => decodeEvent(current, event)),
              ] as const;
            },
            catch: (cause) =>
              AiError.isAiError(cause) ? cause : invalidOutput("Codex stream failed"),
          }),
      ),
      Stream.concat(
        Stream.fromEffect(
          Effect.suspend(() =>
            state.terminal
              ? Effect.void
              : Effect.fail(invalidOutput("Codex stream ended before a terminal response event")),
          ),
        ).pipe(Stream.drain),
      ),
    );
  });

/** Creates the canonical Model backed by the unofficial ChatGPT Codex SSE Responses transport. */
export const codex = (
  model: ModelId,
  credential: CredentialDescriptor = oauth(),
  options: CodexOptions = {},
): Model => {
  const configDirectory = options.configDirectory ?? defaultConfigDirectory();
  const baseUrl = (options.baseUrl ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  const sessionId = crypto.randomUUID();
  const requestStream = (
    providerOptions: LanguageModel.ProviderOptions,
  ): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
    streamText(
      model,
      configDirectory,
      baseUrl,
      options.tokenUrl ?? defaultTokenUrl,
      sessionId,
      providerOptions,
    );
  return makeModel(
    Layer.effect(
      LanguageModel.LanguageModel,
      Effect.tryPromise({ try: () => loadCredential(configDirectory), catch: networkError }).pipe(
        Effect.flatMap(() =>
          LanguageModel.make({
            streamText: requestStream,
            generateText: (providerOptions) =>
              Stream.runCollect(requestStream(providerOptions)).pipe(
                Effect.map((parts) => {
                  const text = [...parts]
                    .filter((part) => part.type === "text-delta")
                    .map((part) => part.delta)
                    .join("");
                  return [
                    ...(text === "" ? [] : [Response.makePart("text", { text })]),
                    ...[...parts].filter((part) => part.type === "tool-call"),
                  ];
                }),
              ),
          }),
        ),
      ),
    ),
    credential,
  );
};

const authPath = (configDirectory: string) => join(configDirectory, "auth.json");
const lockPath = (configDirectory: string) => join(configDirectory, "auth.lock");
const lockTimeout = 30_000;

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const ensureDirectory = async (configDirectory: string): Promise<void> => {
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
};

const acquireLock = async (configDirectory: string) => {
  const path = lockPath(configDirectory);
  const deadline = Date.now() + lockTimeout;
  while (Date.now() < deadline) {
    try {
      return await open(path, "wx", 0o600);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
    try {
      // ponytail: stat+unlink reaping can race a concurrent reaper and drop a
      // fresh lock; atomic temp+rename bounds the damage to one lost update.
      if (Date.now() - (await stat(path)).mtimeMs > lockTimeout) {
        await unlink(path);
        continue;
      }
    } catch (error) {
      // The lock vanished between checks; retry immediately.
      if (isMissing(error)) continue;
      throw error;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Credential storage lock timed out: ${path}`);
};

const readAuth = async (configDirectory: string): Promise<AuthFile> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(authPath(configDirectory), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Credential storage is invalid.");
    }
    return parsed as AuthFile;
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
};

const writeAuth = async (configDirectory: string, auth: AuthFile): Promise<void> => {
  const path = authPath(configDirectory);
  const temporary = join(configDirectory, `.auth-${process.pid}-${crypto.randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(auth)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
};

const modifyAuth = async <A>(
  configDirectory: string,
  update: (auth: AuthFile) => Promise<readonly [AuthFile, A]> | readonly [AuthFile, A],
): Promise<A> => {
  await ensureDirectory(configDirectory);
  const lock = await acquireLock(configDirectory);
  try {
    const [auth, value] = await update(await readAuth(configDirectory));
    await writeAuth(configDirectory, auth);
    return value;
  } finally {
    // Unlink before close: a failing close must not leave the lock behind.
    await unlink(lockPath(configDirectory)).catch((error: unknown) => {
      // A stale-reaped lock is already gone; don't mask the update's own error.
      if (!isMissing(error)) throw error;
    });
    await lock.close();
  }
};

const updateAuth = async (
  configDirectory: string,
  update: (auth: AuthFile) => Promise<AuthFile> | AuthFile,
): Promise<void> => {
  await modifyAuth(configDirectory, async (auth) => [await update(auth), undefined]);
};

/** Stores one provider Credential while preserving all other provider entries. */
export const writeCredential = async (
  configDirectory: string,
  providerKey: string,
  credential: OAuthCredential,
): Promise<void> => updateAuth(configDirectory, (auth) => ({ ...auth, [providerKey]: credential }));

const decodeBase64url = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

const accountId = (access: string): string => {
  const payload = access.split(".")[1];
  if (payload === undefined) throw new Error("OAuth access token did not contain an account.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64url(payload));
  } catch {
    throw new Error("OAuth access token did not contain an account.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("OAuth access token did not contain an account.");
  }
  // Codex nests the account under this claim; some tokens carry it top-level.
  const claims = parsed as Record<string, unknown>;
  const auth = claims["https://api.openai.com/auth"];
  const id =
    typeof auth === "object" && auth !== null
      ? (auth as Record<string, unknown>)["chatgpt_account_id"]
      : claims["chatgpt_account_id"];
  if (typeof id !== "string" || id === "") {
    throw new Error("OAuth access token did not contain an account.");
  }
  return id;
};

const token = async (tokenUrl: string, form: Record<string, string>): Promise<OAuthCredential> => {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    // A refresh runs under the storage lock: an exchange hung past the 30s lock
    // reap window would let another process reap a live lock, so bound it below.
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("OAuth token exchange failed.");
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("access_token" in body) ||
    !("refresh_token" in body) ||
    !("expires_in" in body) ||
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    typeof body.expires_in !== "number"
  ) {
    throw new Error("OAuth token exchange returned an invalid response.");
  }
  return {
    type: "oauth",
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1_000,
    accountId: accountId(body.access_token),
  };
};

// Refresh slightly early so a token expiring mid-flight doesn't cost a 401 round trip.
const isExpired = (credential: OAuthCredential): boolean =>
  Date.now() >= credential.expires - 60_000;

const streamText = (
  model: string,
  configDirectory: string,
  baseUrl: string,
  tokenUrl: string,
  sessionId: string,
  options: LanguageModel.ProviderOptions,
) => {
  const execute = (
    credential: OAuthCredential,
    retried: boolean,
  ): Effect.Effect<
    Stream.Stream<Uint8Array, AiError.AiError>,
    AiError.AiError,
    HttpClient.HttpClient
  > => {
    const request = HttpClientRequest.post(`${baseUrl}/codex/responses`).pipe(
      HttpClientRequest.setHeaders({
        Authorization: `Bearer ${credential.access}`,
        "chatgpt-account-id": credential.accountId,
        originator: "mitome",
        "User-Agent": `mitome (${process.platform} ${process.arch})`,
        "OpenAI-Beta": "responses=experimental",
        accept: "text/event-stream",
        "content-type": "application/json",
        "session-id": sessionId,
        "x-client-request-id": sessionId,
      }),
      HttpClientRequest.bodyJsonUnsafe(requestFor(model, options, sessionId)),
    );
    return HttpClient.execute(request).pipe(
      Effect.mapError(networkError),
      Effect.flatMap((response) => {
        if (response.status === 401 && !retried) {
          return Effect.tryPromise({
            try: () => refreshCredential(configDirectory, tokenUrl, credential.access, false),
            catch: networkError,
          }).pipe(Effect.flatMap((next) => execute(next, true)));
        }
        if (response.status >= 200 && response.status < 300) {
          return Effect.succeed(
            HttpClientResponse.stream(Effect.succeed(response)).pipe(Stream.mapError(networkError)),
          );
        }
        // The backend's error detail ("model not found", quota) beats a bare status.
        return response.text.pipe(
          Effect.orElseSucceed(() => ""),
          Effect.flatMap((body) =>
            Effect.fail(
              AiError.make({
                module: "OpenAI Codex",
                method: "streamText",
                reason: AiError.reasonFromHttpStatus({
                  status: response.status,
                  ...(body === "" ? {} : { description: body.slice(0, 512) }),
                }),
              }),
            ),
          ),
        );
      }),
    );
  };
  return Stream.unwrap(
    Effect.tryPromise({
      try: async () => {
        const current = await loadCredential(configDirectory);
        return isExpired(current)
          ? refreshCredential(configDirectory, tokenUrl, undefined, true)
          : current;
      },
      catch: networkError,
    }).pipe(Effect.flatMap((credential) => execute(credential, false))),
  ).pipe(decodeStream, Stream.provide(FetchHttpClient.layer));
};

type Authorization = {
  readonly code: string | undefined;
  readonly state: string | undefined;
};

const parseAuthorizationInput = (input: string): Authorization => {
  const url = new URL(input);
  return {
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
  };
};

const validateAuthorization = (authorization: Authorization, state: string): string => {
  if (authorization.state !== state) throw new Error("OAuth callback state did not match.");
  if (authorization.code === undefined || authorization.code === "") {
    throw new Error("OAuth callback did not include a code.");
  }
  return authorization.code;
};

const randomHex = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");

const verifier = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const challenge = async (value: string): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "base64url",
  );

const defaultBrowser = (url: string): void => {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  Bun.spawn([command, ...args], { stdout: "ignore", stderr: "ignore" });
};

/** Runs browser PKCE login, falling back to a pasted redirect URL when needed. */
export const login = async (options: LoginOptions): Promise<void> => {
  const port = options.callbackPort ?? 1455;
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const state = randomHex();
  const codeVerifier = verifier();
  const authorization = new URL("https://auth.openai.com/oauth/authorize");
  authorization.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access",
    code_challenge: await challenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    originator: "mitome",
  }).toString();

  const callback = Promise.withResolvers<Authorization>();
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    try {
      server = Bun.serve({
        port,
        hostname: "localhost",
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname !== "/auth/callback")
            return new globalThis.Response("Not found", { status: 404 });
          const received = parseAuthorizationInput(request.url);
          // A stray or mismatched callback must not abort a login in progress.
          if (received.state !== state)
            return new globalThis.Response("Authentication failed.", { status: 400 });
          try {
            validateAuthorization(received, state);
            callback.resolve(received);
            return new globalThis.Response("Authentication complete. You can close this page.");
          } catch (error) {
            // Same-state but no code (e.g. the user cancelled): this is our flow
            // failing authoritatively, so surface it instead of waiting forever.
            callback.reject(error instanceof Error ? error : new Error("OAuth callback failed."));
            return new globalThis.Response("Authentication failed.", { status: 400 });
          }
        },
      });
    } catch (error) {
      // EADDRINUSE: another process holds the port; the pasted redirect flow still works.
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EADDRINUSE"
      ) {
        throw error;
      }
      options.output(`Callback port ${port} is busy; paste the redirect URL instead.\n`);
    }

    options.output(
      `Open this URL to authenticate:\n${authorization.toString()}\nPaste the redirect URL: `,
    );
    const openBrowser = options.openBrowser === undefined ? defaultBrowser : options.openBrowser;
    if (openBrowser !== false) {
      try {
        await openBrowser(authorization.toString());
      } catch {
        // No browser opener (headless host): the printed URL and paste flow remain.
      }
    }
    const manual = options.input().then((input) => {
      if (input === undefined) throw new Error("OAuth input closed.");
      return parseAuthorizationInput(input);
    });
    // The pasted-input branch can lose the race to the callback; a late Enter
    // press must not become an unhandled rejection after login already succeeded.
    manual.catch(() => {});
    const received = await (server === undefined
      ? manual
      : Promise.race([callback.promise, manual]));
    const code = validateAuthorization(received, state);
    await writeCredential(
      options.configDirectory,
      provider,
      await token(options.tokenUrl ?? defaultTokenUrl, {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    );
  } finally {
    void server?.stop(true);
  }
};

/** Removes only the Codex Credential. */
export const logout = async (options: LogoutOptions): Promise<void> => {
  await updateAuth(options.configDirectory, (auth) => {
    const { [provider]: _, ...remaining } = auth;
    return remaining;
  });
  options.output?.("Logged out.\n");
};

const credentialFrom = (value: unknown): OAuthCredential => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "oauth" ||
    !("access" in value) ||
    typeof value.access !== "string" ||
    !("refresh" in value) ||
    typeof value.refresh !== "string" ||
    !("expires" in value) ||
    typeof value.expires !== "number" ||
    !("accountId" in value) ||
    typeof value.accountId !== "string"
  ) {
    throw new Error("Codex Credential is unavailable.");
  }
  return value as OAuthCredential;
};

const loadCredential = async (configDirectory: string): Promise<OAuthCredential> =>
  credentialFrom((await readAuth(configDirectory))[provider]);

/** Refreshes the rotating Credential under the storage lock; a Credential already
 * rotated by another process is reused instead of burning its refresh token. */
const refreshCredential = async (
  configDirectory: string,
  tokenUrl: string,
  failedAccess: string | undefined,
  expiredOnly: boolean,
): Promise<OAuthCredential> =>
  modifyAuth(configDirectory, async (auth) => {
    const current = credentialFrom(auth[provider]);
    if (failedAccess !== undefined && current.access !== failedAccess) return [auth, current];
    if (expiredOnly && !isExpired(current)) return [auth, current];
    const next = await token(tokenUrl, {
      grant_type: "refresh_token",
      refresh_token: current.refresh,
      client_id: clientId,
    });
    return [{ ...auth, [provider]: next }, next];
  });

/** Generic CLI entry point selected through Core's provider-owned capability. */
export const authenticate = async (options: {
  readonly operation: "login" | "logout";
  readonly configDirectory: string;
  readonly input: Input;
  readonly output: Output;
  readonly openBrowser?: false;
}): Promise<void> => {
  if (options.operation === "logout") {
    await logout(options);
    return;
  }
  await login(options);
};
