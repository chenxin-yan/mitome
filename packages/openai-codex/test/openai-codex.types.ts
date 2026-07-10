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
  refresh,
  writeCredential,
} from "../src/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type PublicOAuth = () => CredentialDescriptor;
type PublicCodex = (model: ModelId, credential?: CredentialDescriptor) => Model;
type PublicLogin = (options: LoginOptions) => Promise<void>;
type PublicLogout = (options: LogoutOptions) => Promise<void>;
type PublicWriteCredential = (
  configDirectory: string,
  providerKey: string,
  credential: OAuthCredential,
) => Promise<void>;
type PublicRefresh = (
  configDirectory: string,
  options?: {
    readonly tokenUrl?: string;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
  },
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
  Assert<Equal<typeof refresh, PublicRefresh>>,
  Assert<Equal<typeof authenticate, PublicAuthenticate>>,
] = [true, true, true, true, true, true, true];
void publicContracts;
