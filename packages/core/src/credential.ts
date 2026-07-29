import { Schema } from "effect";

/**
 * Provider-owned credential metadata available without starting a Session: an
 * environment variable name, or a reference to an OAuth capability module.
 */
export const CredentialDescriptorSchema = Schema.Union([
  Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  Schema.Struct({ capability: Schema.Struct({ module: Schema.String }) }),
]);
export type CredentialDescriptor = typeof CredentialDescriptorSchema.Type;

/** Host-facing options passed to an Auth capability's authenticate function. */
export interface AuthenticateOptions {
  readonly operation: "login" | "logout";
  readonly configDirectory: string;
  readonly input: () => Promise<string | undefined>;
  readonly output: (text: string) => void;
  readonly openBrowser?: false;
}

/** Host-facing contract implemented by a Provider's Auth capability module. */
export interface AuthCapability {
  readonly authenticate: (options: AuthenticateOptions) => Promise<void>;
}
