import { Effect } from "effect";
import { type HttpClient } from "effect/unstable/http";
import { exchangeToken, type OAuthToken } from "../shared/oauth.js";
import { type OAuthCredential } from "./types.js";

export const accountId = (access: string): string => {
  const payload = access.split(".")[1];
  if (payload === undefined) throw new Error("OAuth access token did not contain an account.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("OAuth access token did not contain an account.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("OAuth access token did not contain an account.");
  }
  // Codex nests the account under this claim; some tokens carry it top-level.
  const claims = parsed as Record<string, unknown>;
  const auth = claims["https://api.openai.com/auth"];
  const id =
    typeof auth === "object" && auth !== null
      ? (auth as Record<string, unknown>)["chatgpt_account_id"]
      : claims["chatgpt_account_id"];
  if (typeof id !== "string" || id === "") {
    throw new Error("OAuth access token did not contain an account.");
  }
  return id;
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
