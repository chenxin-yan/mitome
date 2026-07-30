import { Schema } from "effect";
import type { AuthorizeOptions } from "../shared/oauth.js";

type Output = (text: string) => void;

export const OAuthCredential = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Finite,
  accountId: Schema.String,
});
export type OAuthCredential = typeof OAuthCredential.Type;

export interface LoginOptions extends AuthorizeOptions {
  readonly configDirectory: string;
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
