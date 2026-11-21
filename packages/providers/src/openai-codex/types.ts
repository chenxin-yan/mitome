import { Schema } from "effect";
import type { AuthorizeOptions } from "../shared/oauth.js";

type Output = (text: string) => void;

export const OAuthCredentialSchema = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Finite,
  accountId: Schema.String,
});
/** The stored ChatGPT OAuth Credential: access and refresh tokens, expiry, and account id. */
export type OAuthCredential = typeof OAuthCredentialSchema.Type;

/** Options for `login`: Host I/O callbacks plus the directory that will hold `auth.json`. */
export interface LoginOptions extends AuthorizeOptions {
  readonly stateDirectory: string;
}

export interface LogoutOptions {
  /** Directory whose `auth.json` loses the Codex entry. */
  readonly stateDirectory: string;
  readonly output?: Output;
}

export interface CodexOptions {
  /** Unofficial ChatGPT backend root; injectable for controlled transport fixtures. */
  readonly baseUrl?: string;
  /** Directory holding `auth.json`; defaults to the Mitome state directory (`stateDirectory` in `@mitome/core`). */
  readonly stateDirectory?: string;
  /** OAuth token endpoint; injectable for controlled refresh fixtures. */
  readonly tokenUrl?: string;
}
