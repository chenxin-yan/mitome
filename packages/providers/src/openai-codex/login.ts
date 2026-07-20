import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { clientId, defaultTokenUrl, provider } from "./constants.js";
import { writeCredential } from "./credential-store.js";
import { token } from "./oauth-token.js";
import { type LoginOptions } from "./types.js";

type Authorization = {
  readonly code: string | undefined;
  readonly state: string | undefined;
};

const parseAuthorizationInput = (input: string): Authorization => {
  const url = new URL(input);
  return {
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
  };
};

const validateAuthorization = (authorization: Authorization, state: string): string => {
  if (authorization.state !== state) throw new Error("OAuth callback state did not match.");
  if (authorization.code === undefined || authorization.code === "") {
    throw new Error("OAuth callback did not include a code.");
  }
  return authorization.code;
};

const randomHex = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");

const verifier = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const challenge = async (value: string): Promise<string> =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "base64url",
  );

const defaultBrowser = (url: string): void => {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
};

/** Runs browser PKCE login, falling back to a pasted redirect URL when needed. */
export const login = async (options: LoginOptions): Promise<void> => {
  const port = options.callbackPort ?? 1455;
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const state = randomHex();
  const codeVerifier = verifier();
  const authorization = new URL("https://auth.openai.com/oauth/authorize");
  authorization.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access",
    code_challenge: await challenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    originator: "mitome",
  }).toString();

  const callback = Promise.withResolvers<Authorization>();
  let server: Server | undefined;
  try {
    try {
      const callbackServer = createServer((request, response) => {
        const url = new URL(request.url ?? "/", redirectUri);
        if (url.pathname !== "/auth/callback") return response.writeHead(404).end("Not found");
        const received = parseAuthorizationInput(url.toString());
        // A stray or mismatched callback must not abort a login in progress.
        if (received.state !== state) return response.writeHead(400).end("Authentication failed.");
        try {
          validateAuthorization(received, state);
          callback.resolve(received);
          return response.end("Authentication complete. You can close this page.");
        } catch (error) {
          // Same-state but no code (e.g. the user cancelled): this is our flow
          // failing authoritatively, so surface it instead of waiting forever.
          callback.reject(error instanceof Error ? error : new Error("OAuth callback failed."));
          return response.writeHead(400).end("Authentication failed.");
        }
      });
      server = callbackServer;
      await new Promise<void>((resolve, reject) => {
        callbackServer.once("error", reject);
        callbackServer.listen(port, "localhost", resolve);
      });
    } catch (error) {
      // EADDRINUSE: another process holds the port; the pasted redirect flow still works.
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EADDRINUSE"
      ) {
        throw error;
      }
      options.output(`Callback port ${port} is busy; paste the redirect URL instead.\n`);
    }

    options.output(
      `Open this URL to authenticate:\n${authorization.toString()}\nPaste the redirect URL: `,
    );
    const openBrowser = options.openBrowser === undefined ? defaultBrowser : options.openBrowser;
    if (openBrowser !== false) {
      try {
        await openBrowser(authorization.toString());
      } catch {
        // No browser opener (headless host): the printed URL and paste flow remain.
      }
    }
    const manual = options.input().then((input) => {
      if (input === undefined) throw new Error("OAuth input closed.");
      return parseAuthorizationInput(input);
    });
    // The pasted-input branch can lose the race to the callback; a late Enter
    // press must not become an unhandled rejection after login already succeeded.
    manual.catch(() => {});
    const received = await (server === undefined
      ? manual
      : Promise.race([callback.promise, manual]));
    const code = validateAuthorization(received, state);
    await writeCredential(
      options.configDirectory,
      provider,
      await token(options.tokenUrl ?? defaultTokenUrl, {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    );
  } finally {
    server?.close();
  }
};
