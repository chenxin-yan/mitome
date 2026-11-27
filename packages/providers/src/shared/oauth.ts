import type { Cause } from "effect";
import { Clock, Deferred, Effect, Match, Option, Predicate, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientError } from "effect/http";
import { ChildProcess } from "effect/process";
import type { ChildProcessSpawner } from "effect/process";
import { serveLocalhost } from "./platform.js";

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

/** Host-side I/O for an OAuth2 PKCE login. */
export interface AuthorizeOptions {
  readonly callbackPort?: number;
  readonly tokenUrl?: string;
  /** `false` skips opening a browser (the user pastes the redirect URL); a function replaces the default opener. */
  readonly openBrowser?: false | ((url: string) => void | Promise<void>) | undefined;
  /** Reads one line from the user; `undefined` once input is closed. */
  readonly input: Effect.Effect<string | undefined, Error>;
  /** Shows one line to the user. */
  readonly output: (text: string) => void;
}

/** The Provider-agnostic result of a token exchange, before Provider enrichment. */
export interface OAuthToken {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
}

export class OAuthTokenError extends Schema.TaggedError<
  OAuthTokenError,
  { readonly brand: unique symbol }
>()("OAuthTokenError", {
  message: Schema.String,
  /** The token endpoint's HTTP status, when it answered with one. */
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The token endpoint said "try later" (429 or 5xx), not that the grant is invalid. */
export const isTemporaryTokenFailure = (error: OAuthTokenError): boolean =>
  error.status !== undefined && (error.status === 429 || error.status >= 500);

/** The token endpoint redirected: that is no answer from it, so it judged no grant. */
export const isRedirectedTokenFailure = (error: OAuthTokenError): boolean =>
  error.status !== undefined && error.status >= 300 && error.status < 400;

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
    if (submitted !== "") {
      redacted = redacted.replaceAll(submitted, "[redacted]");
    }
  }
  return redacted.slice(0, 512);
};

export const exchangeToken = Effect.fnUntraced(
  function* (
    tokenUrl: string,
    form: Record<string, string>,
  ): Effect.fn.Return<OAuthToken, OAuthTokenFailure, HttpClient.HttpClient> {
    const request = HttpClientRequest.post(tokenUrl).pipe(HttpClientRequest.bodyUrlParams(form));
    const requestInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
    const response = yield* HttpClient.execute(request).pipe(
      // A redirect is a failed exchange: following it would resend the form's secrets elsewhere.
      Effect.provideService(FetchHttpClient.RequestInit, {
        ...Option.getOrUndefined(requestInit),
        redirect: "manual",
      }),
    );
    // Not an answer from the token endpoint, so its body is not read as one.
    if (response.status >= 300 && response.status < 400) {
      return yield* new OAuthTokenError({
        message: `OAuth token exchange failed (HTTP ${response.status}).`,
        status: response.status,
      });
    }
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
        status: response.status,
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
      expires: (yield* Clock.currentTimeMillis) + body.expires_in * 1000,
    };
  },
  // Keep refresh bounded while holding the storage lock, including a stalled response body.
  Effect.timeout("15 seconds"),
);

// Refresh slightly early so a token expiring mid-flight doesn't cost a 401 round trip.
export const isExpired = (credential: { readonly expires: number }): Effect.Effect<boolean> =>
  Effect.map(Clock.currentTimeMillis, (now) => now >= credential.expires - 60_000);

/** Why a browser authorization produced no code: a refused or mismatched callback, or no input. */
export class OAuthAuthorizationError extends Schema.TaggedError<
  OAuthAuthorizationError,
  { readonly brand: unique symbol }
>()("OAuthAuthorizationError", { message: Schema.String }) {}

/** The code a redirect to `url` carries for the flow with `state`, or why it carries none. */
const authorizationCode = (url: URL, state: string): string | OAuthAuthorizationError => {
  if (url.searchParams.get("state") !== state) {
    return new OAuthAuthorizationError({ message: "OAuth callback state did not match." });
  }
  const code = url.searchParams.get("code");
  if (code === null || code === "") {
    return new OAuthAuthorizationError({ message: "OAuth callback did not include a code." });
  }
  return code;
};

const verifier = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const challenge = async (value: string): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "base64url",
  );

/**
 * Starts `command` in its own process group and leaves it running. An unreferenced child is not
 * stopped with its Scope, nor is its group when it exits with a failure, as `xdg-open` does after
 * starting a browser. A missing command is ignored: the printed URL and paste flow remain.
 */
export const launchDetached = (
  command: string,
  args: ReadonlyArray<string>,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const child = yield* ChildProcess.make(command, args, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    yield* Effect.asVoid(child.unref);
  }).pipe(Effect.scoped, Effect.ignore);

export const launchDefaultBrowser = (
  url: string,
  launch: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> = launchDetached,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const command = Match.value(process.platform).pipe(
    Match.when("darwin", () => "open"),
    Match.when("win32", () => "rundll32"),
    Match.orElse(() => "xdg-open"),
  );
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return launch(command, args);
};

/** Runs browser PKCE authorization, falling back to a pasted redirect URL when needed. */
export const authorize = Effect.fnUntraced(function* (
  config: OAuthConfig,
  options: AuthorizeOptions,
) {
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
    code_challenge: yield* Effect.promise(() => challenge(codeVerifier)),
    code_challenge_method: "S256",
    state,
    ...config.authorizeParams,
  }).toString();

  const callback = yield* Deferred.make<string, OAuthAuthorizationError>();
  // The server lives in this login's Scope, so it is closed however the login ends.
  const listening = yield* serveLocalhost(port, (target) => {
    const url = URL.parse(target, redirectUri);
    // An unparseable request target is not a callback; it must not abort the login.
    if (url === null) {
      return [400, "Bad request."];
    }
    if (url.pathname !== config.callbackPath) {
      return [404, "Not found"];
    }
    // A stray or mismatched callback must not abort a login in progress.
    if (url.searchParams.get("state") !== state) {
      return [400, "Authentication failed."];
    }
    const code = authorizationCode(url, state);
    if (!Predicate.isString(code)) {
      // Same-state but no code (e.g. the user cancelled): this is our flow
      // failing authoritatively, so surface it instead of waiting forever.
      Deferred.doneUnsafe(callback, Effect.fail(code));
      return [400, "Authentication failed."];
    }
    Deferred.doneUnsafe(callback, Effect.succeed(code));
    return [200, "Authentication complete. You can close this page."];
  });
  if (!listening) {
    options.output(`Callback port ${port} is busy; paste the redirect URL instead.\n`);
  }

  options.output(
    `Open this URL to authenticate:\n${authorization.toString()}\nPaste the redirect URL: `,
  );
  const openBrowser = options.openBrowser;
  // No browser opener (headless host): the printed URL and paste flow remain.
  if (openBrowser === undefined) {
    yield* launchDefaultBrowser(authorization.toString());
  } else if (openBrowser !== false) {
    yield* Effect.ignore(Effect.tryPromise(async () => openBrowser(authorization.toString())));
  }
  const pasted = Effect.flatMap(options.input, (input) => {
    if (input === undefined) {
      return Effect.fail(new OAuthAuthorizationError({ message: "OAuth input closed." }));
    }
    const url = URL.parse(input);
    if (url === null) {
      return Effect.fail(new OAuthAuthorizationError({ message: "Invalid URL" }));
    }
    const code = authorizationCode(url, state);
    return Predicate.isString(code) ? Effect.succeed(code) : Effect.fail(code);
  });
  const code = yield* Effect.raceFirst(Deferred.await(callback), pasted);
  return yield* exchangeToken(options.tokenUrl ?? config.tokenUrl, {
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  }).pipe(Effect.provide(FetchHttpClient.layer));
}, Effect.scoped);
