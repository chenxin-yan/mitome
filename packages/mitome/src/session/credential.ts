import { type Effect, Schema } from "effect";

/** An environment variable name a Provider reads its API key from. */
export const EnvironmentVariableName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
);

const Capability = Schema.Struct({
  module: Schema.String,
  /** The sign-in the capability acts on, when the Provider reads one of several. */
  profile: Schema.optional(Schema.String),
});

/**
 * Provider-owned credential metadata available without starting a Session: an
 * environment variable name, a reference to an Auth capability module, or both
 * when the Provider reads an API key from the variable and otherwise its sign-in.
 */
export const CredentialDescriptorSchema = Schema.Union([
  EnvironmentVariableName,
  Schema.Struct({ env: EnvironmentVariableName, capability: Capability }),
  // A Struct ignores keys it does not declare: without this, an invalid `env` would be dropped and
  // the descriptor accepted as a sign-in only.
  Schema.Struct({ capability: Capability, env: Schema.optionalKey(Schema.Never) }),
]);
/**
 * An environment variable name, a reference to the module exporting an `AuthCapability`, or both:
 * an API key in `env` wins over the capability's sign-in.
 */
export type CredentialDescriptor = typeof CredentialDescriptorSchema.Type;

/** Host-facing options passed to an Auth capability's authenticate function. */
export interface AuthenticateOptions {
  readonly operation: "login" | "logout";
  /**
   * Mitome's state directory, where a capability that stores its Credential itself keeps it (as
   * Codex keeps `auth.json`); a capability whose sign-in another tool stores need not use it.
   */
  readonly stateDirectory: string;
  /** Reads one line from the user; `undefined` once input is closed. */
  readonly input: Effect.Effect<string | undefined, Error>;
  /** Shows one line to the user. */
  readonly output: (text: string) => void;
  /** `false` prevents opening a browser, forcing the paste-the-redirect-URL path. */
  readonly openBrowser?: false | undefined;
  /** The sign-in to act on: the `profile` of the Provider's credential descriptor. */
  readonly profile?: string | undefined;
}

/** Host-facing contract implemented by a Provider's Auth capability module. */
export interface AuthCapability {
  /**
   * Performs `login` or `logout`, storing or removing the Credential where the capability keeps
   * it, for example under `stateDirectory`. It fails with an `Error` whose message the Host shows;
   * interrupting it stops what it started.
   */
  readonly authenticate: (options: AuthenticateOptions) => Effect.Effect<void, Error>;
}
