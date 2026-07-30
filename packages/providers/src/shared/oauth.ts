import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { Cause, Clock, Data, Effect, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
} from "effect/unstable/http";

/** The per-Provider half of an OAuth2 PKCE flow: who we are and where we talk. */
export interface OAuthConfig {
  readonly clientId: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly scope: string;
  /** Port of the registered redirect URI. */
  readonly callbackPort: number;
  /** Path of the registered redirect URI. */
  readonly callbackPath: string;
  /** Non-standard authorization parameters the Provider requires. */
  readonly authorizeParams?: Readonly<Record<string, string>>;
}

export interface AuthorizeOptions {
  readonly callbackPort?: number;
  readonly tokenUrl?: string;
  readonly openBrowser?: false | ((url: string) => void | Promise<void>);
  readonly input: () => Promise<string | undefined>;
  readonly output: (text: string) => void;
}

/** The Provider-agnostic result of a token exchange, before Provider enrichment. */
export interface OAuthToken {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
}

export class OAuthTokenError extends Data.TaggedError("OAuthTokenError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type OAuthTokenFailure =
  | Cause.TimeoutError
  | OAuthTokenError
  | HttpClientError.HttpClientError;

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Finite,
});

const OAuthErrorResponse = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const redactFormValues = (value: string, form: Record<string, string>): string => {
  let redacted = value;
  for (const submitted of Object.values(form)) {
    if (submitted !== "") redacted = redacted.replaceAll(submitted, "[redacted]");
  }
  return redacted.slice(0, 512);
};

export const exchangeToken = (
  tokenUrl: string,
  form: Record<string, string>,
): Effect.Effect<OAuthToken, OAuthTokenFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(tokenUrl).pipe(HttpClientRequest.bodyUrlParams(form));
    const response = yield* HttpClient.execute(request);
    if (response.status < 200 || response.status >= 300) {
      const failure = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(OAuthErrorResponse)),
        Effect.orElseSucceed(() => ({ error: undefined, error_description: undefined })),
      );
      const code = failure.error === undefined ? undefined : redactFormValues(failure.error, form);
      const description =
        failure.error_description === undefined
          ? undefined
          : redactFormValues(failure.error_description, form);
      const detail =
        code === undefined
          ? description
          : description === undefined
            ? code
            : `${code}: ${description}`;
      return yield* new OAuthTokenError({
        message: `OAuth token exchange failed (HTTP ${response.status}${detail === undefined ? "" : `; ${detail}`}).`,
      });
    }
    const body = yield* response.json.pipe(
      Effect.mapError(
        () => new OAuthTokenError({ message: "OAuth token exchange body was not valid JSON." }),
      ),
      Effect.flatMap((json) =>
        Schema.decodeUnknownEffect(OAuthTokenResponse)(json).pipe(
          Effect.mapError(
            () =>
              new OAuthTokenError({
                message: "OAuth token exchange returned an invalid response.",
              }),
          ),
        ),
      ),
    );
    return {
      access: body.access_token,
      refresh: body.refresh_token,
      expires: (yield* Clock.currentTimeMillis) + body.expires_in * 1_000,
    };
  }).pipe(
    // Keep refresh bounded while holding the storage lock, including a stalled response body.
    Effect.timeout("15 seconds"),
  );

// Refresh slightly early so a token expiring mid-flight doesn't cost a 401 round trip.
export const isExpired = (credential: { readonly expires: number }): Effect.Effect<boolean> =>
  Effect.map(Clock.currentTimeMillis, (now) => now >= credential.expires - 60_000);

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

const verifier = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const challenge = async (value: string): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "base64url",
  );

const defaultBrowser = (url: string): void => {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  // spawn ENOENT (no browser); the printed URL/paste flow remains.
  child.on("error", () => {});
  child.unref();
};

/** Runs browser PKCE authorization, falling back to a pasted redirect URL when needed. */
export const authorize = async (
  config: OAuthConfig,
  options: AuthorizeOptions,
): Promise<OAuthToken> => {
  const port = options.callbackPort ?? config.callbackPort;
  const redirectUri = `http://localhost:${port}${config.callbackPath}`;
  const state = crypto.randomUUID();
  const codeVerifier = verifier();
  const authorization = new URL(config.authorizeUrl);
  authorization.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scope,
    code_challenge: await challenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    ...config.authorizeParams,
  }).toString();

  const callback = Promise.withResolvers<Authorization>();
  let server: Server | undefined;
  try {
    try {
      const callbackServer = createServer((request, response) => {
        const url = new URL(request.url ?? "/", redirectUri);
        if (url.pathname !== config.callbackPath) return response.writeHead(404).end("Not found");
        const received = parseAuthorizationInput(url.toString());
        // A stray or mismatched callback must not abort a login in progress.
        if (received.state !== state) return response.writeHead(400).end("Authentication failed.");
        try {
          validateAuthorization(received, state);
          callback.resolve(received);
          return response.end("Authentication complete. You can close this page.");
        } catch (error) {
          // Same-state but no code (e.g. the user cancelled): this is our flow
          // failing authoritatively, so surface it instead of waiting forever.
          callback.reject(error instanceof Error ? error : new Error("OAuth callback failed."));
          return response.writeHead(400).end("Authentication failed.");
        }
      });
      server = callbackServer;
      await new Promise<void>((resolve, reject) => {
        callbackServer.once("error", reject);
        callbackServer.listen(port, "localhost", resolve);
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
    return await Effect.runPromise(
      exchangeToken(options.tokenUrl ?? config.tokenUrl, {
        grant_type: "authorization_code",
        client_id: config.clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
  } finally {
    server?.close();
  }
};
