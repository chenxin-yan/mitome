/**
 * Provider-owned credential metadata available without starting a Session: an
 * environment variable name, or a reference to an OAuth capability module.
 */
export type CredentialDescriptor = string | { readonly capability: { readonly module: string } };

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
