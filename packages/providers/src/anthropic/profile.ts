import { AnthropicClient } from "@effect/ai-anthropic";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Predicate,
  Schema,
} from "effect";
import type { Cause, PlatformError } from "effect";
import { AiError } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientError } from "effect/http";
import { MissingCredentialError, reportingHttpClient } from "../shared/api-key-client.js";
import { withLock, writePrivateFile } from "../shared/credential-store.js";
import type { CredentialStoreError } from "../shared/credential-store.js";
import { isTemporaryTokenFailure, OAuthTokenError } from "../shared/oauth.js";
import { platformLayer } from "../shared/platform.js";
import { UnusableProfileError } from "./profile-error.js";

// What follows reads and refreshes a profile the way Anthropic's TypeScript SDK does
// (`src/core/credentials.ts`, `src/lib/credentials/user-oauth.ts` and `types.ts` of
// `@anthropic-ai/sdk`); Mitome holds no OAuth client id of its own.

/** The profile Mitome reads when none is configured; `ant` and Claude Code share `default`. */
export const defaultProfile = "mitome";

const defaultBaseUrl = "https://api.anthropic.com";
const oauthBeta = "oauth-2025-04-20";
const refreshMarginSeconds = 30;

/** The names Anthropic's SDK accepts, none of which can leave the config directory. */
export const isProfileName = (name: string): boolean =>
  name !== "." && name !== ".." && /^[A-Za-z0-9_.-]+$/.test(name);

export const invalidProfileName = (name: string): string =>
  `Anthropic profile name "${name}" is invalid: use letters, digits, "_", "." and "-".`;

const signInRemedy = (profile: string) =>
  profile === defaultProfile
    ? "run `mitome auth login --provider anthropic` (or `ant auth login --profile=mitome`)"
    : `run \`ant auth login --profile=${profile}\``;

const selectAnother = "select another profile with the `profile` option of `anthropic()`";

const unusable = (message: string) => new UnusableProfileError({ message });

/** The config directory Anthropic's SDK and `ant` use. */
const configDirectory = (path: Path.Path): string | undefined => {
  const env = process.env;
  if (env.ANTHROPIC_CONFIG_DIR) {
    return env.ANTHROPIC_CONFIG_DIR;
  }
  if (process.platform === "win32") {
    if (env.APPDATA) {
      return path.join(env.APPDATA, "Anthropic");
    }
    return env.USERPROFILE
      ? path.join(env.USERPROFILE, "AppData", "Roaming", "Anthropic")
      : undefined;
  }
  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, "anthropic");
  }
  return env.HOME ? path.join(env.HOME, ".config", "anthropic") : undefined;
};

const ProfileConfig = Schema.fromJsonString(
  Schema.Struct({
    authentication: Schema.Struct({
      type: Schema.String,
      client_id: Schema.optional(Schema.String),
      credentials_path: Schema.optional(Schema.String),
    }),
    workspace_id: Schema.optional(Schema.String),
    base_url: Schema.optional(Schema.String),
  }),
);

const CredentialsFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
const Credentials = Schema.Struct({
  type: Schema.optional(Schema.Literal("oauth_token")),
  access_token: Schema.NonEmptyString,
  expires_at: Schema.optional(Schema.NullOr(Schema.Finite)),
  refresh_token: Schema.optional(Schema.String),
});

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Finite,
  refresh_token: Schema.optional(Schema.String),
  token_type: Schema.optional(Schema.String),
});

const TokenErrorResponse = Schema.Struct({ error: Schema.optional(Schema.String) });

/** RFC 6749's token error codes: any other value could echo back what was sent. */
const oauthErrorCodes = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
]);

/** A profile as its config file describes it. */
interface Profile {
  readonly name: string;
  readonly directory: string;
  readonly configPath: string;
  readonly type: string;
  readonly credentialsPath: string;
  /** `undefined` when the profile records none: its access token is then static. */
  readonly clientId: string | undefined;
  readonly workspaceId: string | undefined;
  /** The profile's own API host, which also issued its tokens, as written. */
  readonly baseUrl: string | undefined;
}

/** Whether `current` still routes and authenticates as the profile a Layer was built for. */
const sameProfile = (built: Profile, current: Profile) =>
  built.type === current.type &&
  built.credentialsPath === current.credentialsPath &&
  built.clientId === current.clientId &&
  built.workspaceId === current.workspaceId &&
  built.baseUrl === current.baseUrl;

interface StoredCredentials {
  /** The whole file, so a rewrite keeps the keys Mitome does not read. */
  readonly file: { readonly [key: string]: Schema.Json };
  readonly accessToken: string;
  readonly expiresAt: number | undefined;
  readonly refreshToken: string | undefined;
}

/** `undefined` when nothing is at the path; otherwise fails with what the operating system reported. */
const absentAsUndefined = <A, R>(
  operation: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<A | undefined, unknown, R> =>
  operation.pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
    Effect.mapError((error) => error.cause ?? error),
  );

/** Why `what` could not be read and, when permissions are why, the change that lets Mitome read it. */
const unreadable = (what: string, permission: string) => (cause: unknown) => {
  const code = Predicate.hasProperty(cause, "code") ? cause.code : undefined;
  return unusable(
    code === "EACCES" || code === "EPERM"
      ? `Could not read ${what} (${code}): ${permission}.`
      : `Could not read ${what}: ${String(cause)}.`,
  );
};

// No shell command is built from a path: quoting it right depends on the shell.
const privateCredentials = "make it readable and writable by its owner only (mode 600)";

/** The named profile's config, or `undefined` when it has none. */
const readConfig = Effect.fnUntraced(function* (
  name: string,
  directory: string,
): Effect.fn.Return<Profile | undefined, UnusableProfileError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(directory, "configs", `${name}.json`);
  const text = yield* absentAsUndefined(fs.readFileString(configPath)).pipe(
    Effect.mapError(
      unreadable(
        `the Anthropic profile "${name}" at ${configPath}`,
        "give your user read permission on it",
      ),
    ),
  );
  if (text === undefined) {
    return undefined;
  }
  // `ant auth login` writes a config only where there is none, so signing in again cannot fix one.
  const config = yield* Schema.decodeEffect(ProfileConfig)(text).pipe(
    Effect.mapError(() =>
      unusable(
        `The Anthropic profile "${name}" at ${configPath} is not a valid profile. Repair that file, or remove that file and sign in again (${signInRemedy(name)}), or ${selectAnother}.`,
      ),
    ),
  );
  return {
    name,
    directory,
    configPath,
    type: config.authentication.type,
    credentialsPath:
      config.authentication.credentials_path || path.join(directory, "credentials", `${name}.json`),
    clientId: config.authentication.client_id || undefined,
    workspaceId: config.workspace_id || undefined,
    baseUrl: config.base_url || undefined,
  };
});

/**
 * The named profile, or `undefined` when it does not exist. A profile that exists but cannot be
 * used fails with what is wrong with it.
 */
const readProfile = Effect.fnUntraced(function* (
  name: string,
): Effect.fn.Return<Profile | undefined, UnusableProfileError, FileSystem.FileSystem | Path.Path> {
  if (!isProfileName(name)) {
    return yield* unusable(invalidProfileName(name));
  }
  const directory = configDirectory(yield* Path.Path);
  if (directory === undefined) {
    return undefined;
  }
  const profile = yield* readConfig(name, directory);
  if (profile === undefined || profile.type === "user_oauth") {
    return profile;
  }
  return yield* unusable(
    `The Anthropic profile "${name}" at ${profile.configPath} uses authentication type "${profile.type}"; Mitome reads only the Claude Console sign-in ("user_oauth") that \`ant auth login\` writes. Select another profile with the \`profile\` option of \`anthropic()\`, or remove that file and sign in again (${signInRemedy(name)}).`,
  );
});

/**
 * The credentials in the file at `path`, or `undefined` when there is none (it was signed out).
 * The mode is checked on the file that is read, not on whatever the path names later.
 */
const readCredentials = Effect.fnUntraced(function* (
  profile: Profile,
  path: string,
): Effect.fn.Return<StoredCredentials | undefined, UnusableProfileError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  // Both from one handle, so the mode checked is the mode of what was read.
  const read = yield* absentAsUndefined(
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(path, { flag: "r" });
        const { mode } = yield* file.stat;
        const chunks: Array<Uint8Array> = [];
        // Read to the end rather than to the reported size: a pipe reports none.
        let chunk = yield* file.readAlloc(64 * 1024);
        while (Option.isSome(chunk)) {
          chunks.push(chunk.value);
          chunk = yield* file.readAlloc(64 * 1024);
        }
        return { mode: mode & 0o777, text: Buffer.concat(chunks).toString("utf8") };
      }),
    ),
  ).pipe(
    Effect.mapError(
      unreadable(
        `the Anthropic credentials file ${path} of profile "${profile.name}"`,
        privateCredentials,
      ),
    ),
  );
  if (read === undefined) {
    return undefined;
  }
  // Tokens another user can read can be stolen; ones another user can write can be planted.
  if (process.platform !== "win32" && (read.mode & 0o066) !== 0) {
    return yield* unusable(
      `The Anthropic credentials file ${path} can be read or written by other users (mode 0o${read.mode.toString(8)}); ${privateCredentials}.`,
    );
  }
  const invalid = unusable(
    `The Anthropic credentials file ${path} of profile "${profile.name}" is not valid. Sign in again: ${signInRemedy(profile.name)}.`,
  );
  const file = yield* Schema.decodeEffect(CredentialsFile)(read.text).pipe(
    Effect.mapError(() => invalid),
  );
  const credentials = yield* Schema.decodeUnknownEffect(Credentials)(file).pipe(
    Effect.mapError(() => invalid),
  );
  return {
    file,
    accessToken: credentials.access_token,
    expiresAt: credentials.expires_at ?? undefined,
    refreshToken: credentials.refresh_token || undefined,
  };
});

const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000));

/** A token without an expiry never needs refreshing. */
const isFresh = (credentials: StoredCredentials) =>
  Effect.map(
    nowSeconds,
    (now) =>
      credentials.expiresAt === undefined || now < credentials.expiresAt - refreshMarginSeconds,
  );

/** What a refresh needs, unless the profile cannot be refreshed. */
const refreshGrant = (profile: Profile, credentials: StoredCredentials, rejected: boolean) => {
  if (profile.clientId !== undefined && credentials.refreshToken !== undefined) {
    return Effect.succeed({ clientId: profile.clientId, refreshToken: credentials.refreshToken });
  }
  const cannot = `The Anthropic sign-in of profile "${profile.name}" ${rejected ? "was rejected by the Anthropic API" : "has expired"} and cannot be refreshed`;
  // `ant auth login` keeps an existing config, so signing in again would not add a client id.
  return Effect.fail(
    unusable(
      profile.clientId === undefined
        ? `${cannot}: the profile records no client id. Repair ${profile.configPath}, or remove that file and sign in again (${signInRemedy(profile.name)}), or ${selectAnother}.`
        : `${cannot}: the profile records no refresh token. Sign in again: ${signInRemedy(profile.name)}.`,
    ),
  );
};

/**
 * `value` as an API root a sign-in's tokens may go to: https, or http to this machine for local
 * testing, naming no user, query or fragment, which the request URLs built on it would carry.
 */
const tokenDestination = (value: string): URL | undefined => {
  if (!URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  // The href keeps even an empty query or fragment.
  return secure && url.username === "" && url.password === "" && !/[?#]/.test(url.href)
    ? url
    : undefined;
};

/** `path` under the API root `base`, which may have a path of its own (a proxy's). */
const endpoint = (base: URL, path: string): string => {
  const url = new URL(base);
  url.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
  return url.href;
};

type RefreshFailure =
  | UnusableProfileError
  | OAuthTokenError
  | HttpClientError.HttpClientError
  | Cause.TimeoutError;

/**
 * Exchanges the refresh token. A rejected grant means the sign-in is gone; a 429 or 5xx is
 * temporary; anything else is a broken endpoint, which signing in again would not fix. Nothing the
 * endpoint returns is copied into a failure but its status and a known OAuth error code.
 */
const requestRefresh = Effect.fnUntraced(
  function* (
    profile: Profile,
    tokenUrl: string,
    grant: { readonly clientId: string; readonly refreshToken: string },
  ): Effect.fn.Return<typeof TokenResponse.Type, RefreshFailure, HttpClient.HttpClient> {
    const broken = (what: string, status?: number) =>
      new OAuthTokenError({
        message: `The Anthropic token endpoint ${tokenUrl} did not refresh the sign-in of profile "${profile.name}" (${what}). Check \`base_url\` and \`authentication.client_id\` in ${profile.configPath}, or ${selectAnother}.`,
        status,
      });
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(tokenUrl).pipe(
        HttpClientRequest.setHeader("anthropic-beta", oauthBeta),
        HttpClientRequest.bodyJsonUnsafe({
          grant_type: "refresh_token",
          refresh_token: grant.refreshToken,
          client_id: grant.clientId,
        }),
      ),
    ).pipe(
      // A redirect is a failed refresh: following it would resend the refresh token elsewhere.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    );
    const status = response.status;
    // Not an answer from the token endpoint, whatever its body says.
    if (status >= 300 && status < 400) {
      return yield* broken(`HTTP ${status}`, status);
    }
    if (status < 200 || status >= 300) {
      const failure = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(TokenErrorResponse)),
        Effect.orElseSucceed(() => ({ error: undefined })),
      );
      const code =
        failure.error !== undefined && oauthErrorCodes.has(failure.error)
          ? failure.error
          : undefined;
      const what = `HTTP ${status}${code === undefined ? "" : `; ${code}`}`;
      const temporary = new OAuthTokenError({
        message: `The Anthropic sign-in of profile "${profile.name}" could not be refreshed right now (${what}); try again later.`,
        status,
      });
      if (isTemporaryTokenFailure(temporary)) {
        return yield* temporary;
      }
      if (code === "invalid_grant") {
        return yield* unusable(
          `The Anthropic sign-in of profile "${profile.name}" expired or was revoked (token refresh failed: ${what}). Sign in again: ${signInRemedy(profile.name)}.`,
        );
      }
      return yield* broken(what, status);
    }
    const body = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)),
      Effect.mapError(() => broken("an invalid response")),
    );
    if (body.token_type !== undefined && body.token_type.toLowerCase() !== "bearer") {
      return yield* broken("a token type other than Bearer");
    }
    return body;
  },
  // Bounded, since it runs while holding the profile's lock.
  Effect.timeout("15 seconds"),
);

type TokenFailure = UnusableProfileError | CredentialStoreError | RefreshFailure;

/** The file the profile's credentials path names, links followed; `undefined` when there is none. */
const credentialsTarget = (profile: Profile) =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    absentAsUndefined(fs.realPath(profile.credentialsPath)).pipe(
      Effect.mapError(
        unreadable(
          `the Anthropic credentials file ${profile.credentialsPath} of profile "${profile.name}"`,
          privateCredentials,
        ),
      ),
    ),
  );

/**
 * The access tokens of one provisioned profile. Each call reads the profile again, so a token
 * another process rotated is used, and fails closed if the profile now names another host,
 * client, workspace or file. A token about to expire, or one the API rejected, is refreshed under a
 * lock next to the credentials file, after reading the file again, so concurrent Mitome processes
 * refresh it once; Anthropic's own tools do not take that lock. Concurrent requests through one
 * provisioned Model share one refresh, failure included.
 */
export const tokenSource = (profile: Profile, credentialsFile: string, tokenUrl: string) => {
  const changed = unusable(
    `The Anthropic profile "${profile.name}" at ${profile.configPath} changed while this Session was running; restart the Session to use it.`,
  );
  const sameConfig = Effect.flatMap(readConfig(profile.name, profile.directory), (current) =>
    current !== undefined && sameProfile(profile, current) ? Effect.void : Effect.fail(changed),
  );

  // The config is read again after the credentials, so they were read while it named the
  // provisioned host and file: the two files cannot be read atomically.
  const readCurrent = Effect.gen(function* () {
    yield* sameConfig;
    const target = yield* credentialsTarget(profile);
    if (target !== undefined && target !== credentialsFile) {
      return yield* changed;
    }
    const stored =
      target === undefined ? undefined : yield* readCredentials(profile, credentialsFile);
    if (stored === undefined) {
      return yield* unusable(
        `The Anthropic profile "${profile.name}" is signed out. Sign in again: ${signInRemedy(profile.name)}.`,
      );
    }
    yield* sameConfig;
    return stored;
  });

  /** Whether `stored` can be sent instead of refreshing: fresh, and not the token the API rejected. */
  const usable = (stored: StoredCredentials, rejected: string | undefined) =>
    Effect.map(isFresh(stored), (fresh) => fresh && stored.accessToken !== rejected);

  const refreshUnderLock = (rejected: string | undefined) =>
    withLock(
      `${credentialsFile}.lock`,
      Effect.gen(function* () {
        const current = yield* readCurrent;
        if (yield* usable(current, rejected)) {
          return current.accessToken;
        }
        const grant = yield* refreshGrant(profile, current, rejected !== undefined);
        // Once the grant is sent the endpoint may rotate it, so its answer is written before the
        // caller's interruption is delivered.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const tokens = yield* requestRefresh(profile, tokenUrl, grant).pipe(
              Effect.catchTag("UnusableProfileError", Effect.succeed),
            );
            // `ant` takes no lock: a sign-out or a new sign-in during the exchange stands, even
            // when it is why the grant was rejected.
            const latest = yield* readCurrent;
            if (latest.refreshToken !== grant.refreshToken) {
              return latest.accessToken;
            }
            if (tokens instanceof UnusableProfileError) {
              return yield* tokens;
            }
            yield* writePrivateFile(
              credentialsFile,
              `${credentialsFile}.${process.pid}.${crypto.randomUUID()}.tmp`,
              JSON.stringify(
                {
                  ...latest.file,
                  version: "1.0",
                  type: "oauth_token",
                  access_token: tokens.access_token,
                  expires_at: (yield* nowSeconds) + tokens.expires_in,
                  refresh_token: tokens.refresh_token || grant.refreshToken,
                },
                null,
                2,
              ),
            );
            return tokens.access_token;
          }),
        );
      }),
    );

  // A refresh answers `undefined` when the caller that started it was interrupted: those waiting
  // on it start their own.
  let inFlight:
    | {
        readonly rejected: string | undefined;
        readonly refreshed: Deferred.Deferred<string | undefined, TokenFailure>;
      }
    | undefined;
  // The refresh belongs to the caller that starts it; registering it and starting it is one step
  // its interruption cannot split, so whoever registers a refresh also completes it.
  const sharedRefresh = (
    rejected: string | undefined,
  ): Effect.Effect<
    string,
    TokenFailure,
    HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
  > =>
    Effect.uninterruptibleMask((restore) => {
      if (inFlight !== undefined) {
        const joined = inFlight;
        // A refresh for another rejected token can answer with this caller's own rejected token,
        // read from disk: this caller then checks again under the lock for itself.
        return restore(Deferred.await(joined.refreshed)).pipe(
          Effect.map((token) =>
            token === rejected && joined.rejected !== rejected ? undefined : token,
          ),
        );
      }
      const refreshed = Deferred.makeUnsafe<string | undefined, TokenFailure>();
      inFlight = { rejected, refreshed };
      return restore(refreshUnderLock(rejected)).pipe(
        Effect.onExit((exit) => {
          inFlight = undefined;
          return Deferred.done(
            refreshed,
            Exit.hasInterrupts(exit) ? Exit.succeed(undefined) : exit,
          );
        }),
      );
    }).pipe(Effect.filterOrElse(Predicate.isString, () => sharedRefresh(rejected)));

  /** A token to send, other than `rejected`, the one the API just refused, when given. */
  return (
    rejected?: string,
  ): Effect.Effect<
    string,
    TokenFailure,
    HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
  > =>
    rejected === undefined
      ? Effect.flatMap(readCurrent, (stored) =>
          Effect.flatMap(isFresh(stored), (fresh) =>
            fresh ? Effect.succeed(stored.accessToken) : sharedRefresh(undefined),
          ),
        )
      : sharedRefresh(rejected);
};

const tokenError = (error: TokenFailure) =>
  AiError.make({
    module: "AnthropicProfile",
    method: "accessToken",
    reason: Match.value(error).pipe(
      Match.tagsExhaustive({
        UnusableProfileError: ({ message }) =>
          new AiError.AuthenticationError({ kind: "Unknown", description: message }),
        // The reasons keep the message, which a rate-limit reason would drop.
        OAuthTokenError: (failure) =>
          isTemporaryTokenFailure(failure)
            ? new AiError.InternalProviderError({ description: failure.message })
            : new AiError.UnknownError({ description: failure.message }),
        CredentialStoreError: ({ message }) => new AiError.UnknownError({ description: message }),
        HttpClientError: ({ message }) =>
          new AiError.UnknownError({
            description: `Could not reach the Anthropic token endpoint: ${message}`,
          }),
        TimeoutError: () =>
          new AiError.UnknownError({ description: "The Anthropic token refresh timed out." }),
      }),
    ),
  });

/** The Model endpoint refused the bearer token. */
const isUnauthorized = ({ reason }: AiError.AiError) =>
  Predicate.isTagged(reason, "AuthenticationError") && reason.http?.response?.status === 401;

/** The access token of the Model request in progress. */
const CurrentAccessToken = Context.Reference<string | undefined>(
  "@mitome/providers/anthropic/CurrentAccessToken",
  { defaultValue: () => undefined },
);

/** Adds the oauth beta to the request's own `anthropic-beta` values instead of replacing them. */
const withOAuthBeta = (
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  const betas =
    request.headers["anthropic-beta"]
      ?.split(",")
      .map((beta) => beta.trim())
      .filter(Boolean) ?? [];
  return betas.includes(oauthBeta)
    ? request
    : HttpClientRequest.setHeader(request, "anthropic-beta", [...betas, oauthBeta].join(","));
};

/** Authenticates each request with the profile's token, as Anthropic's SDK does, with no API key. */
const authorize =
  (workspaceId: string | undefined) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequestEffect(client, (request) =>
      Effect.map(Effect.service(CurrentAccessToken), (token) => {
        const authorized = withOAuthBeta(
          token === undefined ? request : HttpClientRequest.bearerToken(request, token),
        );
        return workspaceId === undefined || "anthropic-workspace-id" in authorized.headers
          ? authorized
          : HttpClientRequest.setHeader(authorized, "anthropic-workspace-id", workspaceId);
      }),
    );

/**
 * The Anthropic client authenticated by the named Claude Console profile, which `ant auth login`
 * writes. Model requests go through the request-accounting client; token refreshes do not, so
 * they are never counted as Model requests.
 */
export const profileClientLayer = (
  apiKeyEnv: string,
  name: string,
  baseUrl: string | undefined,
): Layer.Layer<AnthropicClient.AnthropicClient, MissingCredentialError | UnusableProfileError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const missing = new MissingCredentialError({
        apiKeyEnv,
        signIn: `sign in to the Claude Console: ${signInRemedy(name)}`,
      });
      const profile = yield* readProfile(name);
      if (profile === undefined) {
        return yield* missing;
      }
      // A setting that is given but unusable fails rather than falling back to another host. The
      // error names the setting, not its value, which may hold a secret.
      const destination = (value: string | undefined, setting: string) => {
        const url = value === undefined ? undefined : tokenDestination(value);
        return value === undefined || url !== undefined
          ? Effect.succeed(url)
          : Effect.fail(
              unusable(
                `Cannot send the tokens of the Anthropic profile "${name}": ${setting} must be an https URL (http only to this machine) with no user name, password, query or fragment.`,
              ),
            );
      };
      const optionBase = yield* destination(baseUrl, "the `baseUrl` option of `anthropic()`");
      const profileBase = yield* destination(
        profile.baseUrl,
        `\`base_url\` in ${profile.configPath}`,
      );
      const apiBase = optionBase ?? profileBase ?? new URL(defaultBaseUrl);
      // The refresh token goes only to its issuer: a proxy trusted to forward Model requests is
      // not thereby trusted with the long-lived grant.
      const tokenBase = profileBase ?? new URL(defaultBaseUrl);
      // Resolved once, so every alias of one file reads, locks and replaces the same file, and a
      // link to it stays a link.
      const credentialsFile = yield* credentialsTarget(profile);
      const stored =
        credentialsFile === undefined
          ? undefined
          : yield* readCredentials(profile, credentialsFile);
      if (credentialsFile === undefined || stored === undefined) {
        return yield* missing;
      }
      if (!(yield* isFresh(stored))) {
        yield* refreshGrant(profile, stored, false);
      }
      const authenticated = Layer.effect(
        AnthropicClient.AnthropicClient,
        Effect.gen(function* () {
          const client = yield* AnthropicClient.AnthropicClient;
          const tokenClient = yield* HttpClient.HttpClient;
          // Only these two: the rest of this context must not replace what a request brings.
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tokens = tokenSource(
            profile,
            credentialsFile,
            endpoint(tokenBase, "/v1/oauth/token"),
          );
          const token = (rejected?: string) =>
            tokens(rejected).pipe(
              Effect.provideService(HttpClient.HttpClient, tokenClient),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.mapError(tokenError),
            );
          // As Anthropic's SDK does, a token the API rejects is replaced once and the request sent
          // once more. A stream is retried only before it starts, when its response is the 401.
          const withToken = <A>(send: Effect.Effect<A, AiError.AiError>) =>
            Effect.flatMap(token(), (used) =>
              send.pipe(
                Effect.provideService(CurrentAccessToken, used),
                Effect.catchIf(isUnauthorized, (rejection) =>
                  Effect.flatMap(token(used), (replaced) =>
                    // The same token again would only be refused again.
                    replaced === used
                      ? Effect.fail(rejection)
                      : Effect.provideService(send, CurrentAccessToken, replaced),
                  ),
                ),
              ),
            );
          return {
            ...client,
            createMessage: (options) => withToken(client.createMessage(options)),
            createMessageStream: (options) => withToken(client.createMessageStream(options)),
          };
        }),
      );
      return authenticated.pipe(
        Layer.provide(
          Layer.merge(
            AnthropicClient.layer({
              // The client appends its request paths, which start with /v1.
              apiUrl: apiBase.href.replace(/\/+$/, ""),
              transformClient: authorize(profile.workspaceId),
            }).pipe(Layer.provide(reportingHttpClient)),
            FetchHttpClient.layer,
          ),
        ),
      );
    }),
  ).pipe(Layer.provide(platformLayer));
