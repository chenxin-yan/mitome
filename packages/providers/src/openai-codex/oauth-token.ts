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

export const token = async (
  tokenUrl: string,
  form: Record<string, string>,
): Promise<OAuthCredential> => {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    // A refresh runs under the storage lock: an exchange hung past the 30s lock
    // reap window would let another process reap a live lock, so bound it below.
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("OAuth token exchange failed.");
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("access_token" in body) ||
    !("refresh_token" in body) ||
    !("expires_in" in body) ||
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    typeof body.expires_in !== "number"
  ) {
    throw new Error("OAuth token exchange returned an invalid response.");
  }
  return {
    type: "oauth",
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1_000,
    accountId: accountId(body.access_token),
  };
};

// Refresh slightly early so a token expiring mid-flight doesn't cost a 401 round trip.
export const isExpired = (credential: OAuthCredential): boolean =>
  Date.now() >= credential.expires - 60_000;
