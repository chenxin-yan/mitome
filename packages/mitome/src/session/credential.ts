import { type Effect, Schema } from "effect";

/**
 * Provider-owned credential metadata available without starting a Session: an
 * environment variable name, or a reference to an OAuth capability module.
 */
export const CredentialDescriptorSchema = Schema.Union([
  Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  Schema.Struct({ capability: Schema.Struct({ module: Schema.String }) }),
]);
/** An environment variable name, or a reference to the module exporting an `AuthCapability`. */
export type CredentialDescriptor = typeof CredentialDescriptorSchema.Type;

/** Host-facing options passed to an Auth capability's authenticate function. */
export interface AuthenticateOptions {
  readonly operation: "login" | "logout";
  /** Directory holding Credential stores such as `auth.json`. */
  readonly stateDirectory: string;
  /** Reads one line from the user; `undefined` once input is closed. */
  readonly input: Effect.Effect<string | undefined, Error>;
  /** Shows one line to the user. */
  readonly output: (text: string) => void;
  /** `false` prevents opening a browser, forcing the paste-the-redirect-URL path. */
  readonly openBrowser?: false | undefined;
}

/** Host-facing contract implemented by a Provider's Auth capability module. */
export interface AuthCapability {
  /**
   * Performs `login` or `logout` and stores or removes the Credential under `stateDirectory`. It
   * fails with an `Error` whose message the Host shows; interrupting it stops what it started.
   */
  readonly authenticate: (options: AuthenticateOptions) => Effect.Effect<void, Error>;
}
