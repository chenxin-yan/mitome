import type { CredentialDescriptor, Model } from "@mitome/core";
import {
  type LoginOptions,
  type LogoutOptions,
  type ModelId,
  type OAuthCredential,
  authenticate,
  codex,
  login,
  logout,
  oauth,
  writeCredential,
} from "../src/index.js";

// Option shapes are pinned to literals (not the exported aliases) so a leaked
// or widened field fails to compile, matching openai.types.ts.
type LiteralLoginOptions = {
  readonly configDirectory: string;
  readonly callbackPort?: number;
  readonly tokenUrl?: string;
  readonly openBrowser?: false | ((url: string) => void | Promise<void>);
  readonly input: () => Promise<string | undefined>;
  readonly output: (text: string) => void;
};
type LiteralLogoutOptions = {
  readonly configDirectory: string;
  readonly output?: (text: string) => void;
};
type LiteralOAuthCredential = {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId: string;
};

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type PublicOAuth = () => CredentialDescriptor;
type PublicCodex = (model: ModelId, credential?: CredentialDescriptor) => Model;
type PublicLogin = (options: LiteralLoginOptions) => Promise<void>;
type PublicLogout = (options: LiteralLogoutOptions) => Promise<void>;
type PublicWriteCredential = (
  configDirectory: string,
  providerKey: string,
  credential: LiteralOAuthCredential,
) => Promise<void>;
type PublicAuthenticate = (options: {
  readonly operation: "login" | "logout";
  readonly configDirectory: string;
  readonly input: () => Promise<string | undefined>;
  readonly output: (text: string) => void;
  readonly openBrowser?: false;
}) => Promise<void>;

const publicContracts: [
  Assert<Equal<typeof oauth, PublicOAuth>>,
  Assert<Equal<typeof codex, PublicCodex>>,
  Assert<Equal<typeof login, PublicLogin>>,
  Assert<Equal<typeof logout, PublicLogout>>,
  Assert<Equal<typeof writeCredential, PublicWriteCredential>>,
  Assert<Equal<typeof authenticate, PublicAuthenticate>>,
  Assert<Equal<LoginOptions, LiteralLoginOptions>>,
  Assert<Equal<LogoutOptions, LiteralLogoutOptions>>,
  Assert<Equal<OAuthCredential, LiteralOAuthCredential>>,
] = [true, true, true, true, true, true, true, true, true];
void publicContracts;
