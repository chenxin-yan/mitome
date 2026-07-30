import type { Provider } from "@mitome/core";
import {
  type CodexOptions,
  type KnownModelId,
  type LoginOptions,
  type LogoutOptions,
  type OAuthCredential,
  authenticate,
  codex,
  knownModelIds,
  login,
  logout,
} from "../../src/openai-codex/index.js";

type LiteralLoginOptions = {
  readonly configDirectory: string;
  readonly callbackPort?: number;
  readonly tokenUrl?: string;
  readonly openBrowser?: false | ((url: string) => void | Promise<void>) | undefined;
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
type LiteralCodexOptions = {
  readonly baseUrl?: string;
  readonly configDirectory?: string;
  readonly tokenUrl?: string;
};

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type PublicLogin = (options: LiteralLoginOptions) => Promise<void>;
type PublicLogout = (options: LiteralLogoutOptions) => Promise<void>;
type PublicAuthenticate = (options: {
  readonly operation: "login" | "logout";
  readonly configDirectory: string;
  readonly input: () => Promise<string | undefined>;
  readonly output: (text: string) => void;
  readonly openBrowser?: false | undefined;
}) => Promise<void>;

const publicContracts: [
  Assert<Equal<string extends KnownModelId ? true : false, false>>,
  Assert<
    Equal<typeof codex, (options?: CodexOptions) => Provider<"openai-codex", typeof knownModelIds>>
  >,
  Assert<Equal<typeof login, PublicLogin>>,
  Assert<Equal<typeof logout, PublicLogout>>,
  Assert<Equal<typeof authenticate, PublicAuthenticate>>,
  Assert<Equal<LoginOptions, LiteralLoginOptions>>,
  Assert<Equal<LogoutOptions, LiteralLogoutOptions>>,
  Assert<Equal<OAuthCredential, LiteralOAuthCredential>>,
  Assert<Equal<CodexOptions, LiteralCodexOptions>>,
] = [true, true, true, true, true, true, true, true, true];
void publicContracts;
