// Adapted from Pi (MIT License). Copyright (c) 2025 Mario Zechner.
import { Effect, Layer, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { makeModel, type CredentialDescriptor, type Model } from "@mitome/core";

const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const provider = "openai-codex";
const defaultTokenUrl = "https://auth.openai.com/oauth/token";

export type ModelId = string;

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

class CodexTransportUnavailableError extends Schema.TaggedErrorClass<CodexTransportUnavailableError>()(
  "CodexTransportUnavailableError",
  { message: Schema.String },
) {}

/** Declares the single ChatGPT Credential used by a Codex Model. */
export const oauth = (): CredentialDescriptor => ({
  capability: { module: import.meta.url },
});

/** Creates a Codex Model. Streaming transport is intentionally deferred to ticket #13. */
export const codex = (model: ModelId, credential: CredentialDescriptor = oauth()): Model => {
  void model;
  return makeModel(
    Layer.effect(
      LanguageModel.LanguageModel,
      Effect.fail(new CodexTransportUnavailableError({ message: "Codex transport lands in #13." })),
    ) as Layer.Layer<LanguageModel.LanguageModel, CodexTransportUnavailableError, never>,
    credential,
  );
};

const authPath = (configDirectory: string) => join(configDirectory, "auth.json");
const lockPath = (configDirectory: string) => join(configDirectory, "auth.lock");

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const ensureDirectory = async (configDirectory: string): Promise<void> => {
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
};

const acquireLock = async (configDirectory: string) => {
  const path = lockPath(configDirectory);
  for (let retry = 0; retry < 2; retry += 1) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
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
        await Bun.sleep(10);
      }
    }
    try {
      if (Date.now() - (await stat(path)).mtimeMs > 30_000) {
        await unlink(path);
        continue;
      }
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    break;
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

const updateAuth = async (
  configDirectory: string,
  update: (auth: AuthFile) => Promise<AuthFile> | AuthFile,
): Promise<void> => {
  await ensureDirectory(configDirectory);
  const lock = await acquireLock(configDirectory);
  try {
    await writeAuth(configDirectory, await update(await readAuth(configDirectory)));
  } finally {
    await lock.close();
    await unlink(lockPath(configDirectory));
  }
};

/** Stores one provider Credential while preserving all other provider entries. */
export const writeCredential = async (
  configDirectory: string,
  providerKey: string,
  credential: OAuthCredential,
): Promise<void> => updateAuth(configDirectory, (auth) => ({ ...auth, [providerKey]: credential }));

const base64url = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

const accountId = (access: string): string => {
  const payload = access.split(".")[1];
  if (payload === undefined) throw new Error("OAuth access token did not contain an account.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64url(payload));
  } catch {
    throw new Error("OAuth access token did not contain an account.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("chatgpt_account_id" in parsed) ||
    typeof parsed.chatgpt_account_id !== "string"
  ) {
    throw new Error("OAuth access token did not contain an account.");
  }
  return parsed.chatgpt_account_id;
};

const token = async (tokenUrl: string, form: Record<string, string>): Promise<OAuthCredential> => {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
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
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname !== "/auth/callback") return new Response("Not found", { status: 404 });
          const received = parseAuthorizationInput(request.url);
          try {
            validateAuthorization(received, state);
            callback.resolve(received);
            return new Response("Authentication complete. You can close this page.");
          } catch (error) {
            callback.reject(error instanceof Error ? error : new Error("OAuth callback failed."));
            return new Response("Authentication failed.", { status: 400 });
          }
        },
      });
    } catch {
      // A busy callback port still permits the pasted redirect flow.
    }

    options.output(
      `Open this URL to authenticate:\n${authorization.toString()}\nPaste the redirect URL: `,
    );
    const openBrowser = options.openBrowser === undefined ? defaultBrowser : options.openBrowser;
    if (openBrowser !== false) await openBrowser(authorization.toString());
    const manual = options.input().then((input) => {
      if (input === undefined) throw new Error("OAuth input closed.");
      return parseAuthorizationInput(input);
    });
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
