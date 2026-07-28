import { Effect, Schema } from "effect";
import { type HttpClient } from "effect/unstable/http";
import { exchangeToken, type OAuthToken } from "../shared/oauth.js";
import { type OAuthCredential } from "./types.js";

const AccountClaim = Schema.Struct({ chatgpt_account_id: Schema.String });
const missingAccount = () => new Error("OAuth access token did not contain an account.");

export const accountId = (access: string): string => {
  const payload = access.split(".")[1];
  if (payload === undefined) throw missingAccount();
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    // A present nested object is authoritative, even when it lacks the account id.
    const auth = claims["https://api.openai.com/auth"];
    const source = typeof auth === "object" && auth !== null ? auth : claims;
    const { chatgpt_account_id } = Schema.decodeUnknownSync(AccountClaim)(source);
    if (chatgpt_account_id === "") throw missingAccount();
    return chatgpt_account_id;
  } catch {
    throw missingAccount();
  }
};

/** Codex Credentials carry the account the unofficial backend routes on. */
export const credential = (token: OAuthToken): OAuthCredential => ({
  type: "oauth",
  ...token,
  accountId: accountId(token.access),
});

export const token = (
  tokenUrl: string,
  form: Record<string, string>,
): Effect.Effect<OAuthCredential, Error, HttpClient.HttpClient> =>
  Effect.map(exchangeToken(tokenUrl, form), credential);
