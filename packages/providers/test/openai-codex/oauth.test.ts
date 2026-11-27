import { createServer } from "node:http";
import { connect } from "node:net";
import { afterAll, describe, expect, test, vi } from "vite-plus/test";
import { Effect, Fiber, Schema } from "effect";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Provider } from "@mitome/core";
import { serve } from "../support.js";
import {
  loadCredential as loadCredentialEffect,
  writeCredential as writeCredentialEffect,
} from "../../src/openai-codex/credential-store.js";
import { codex, login as loginEffect, logout } from "../../src/openai-codex/index.js";
import { accountId } from "../../src/openai-codex/oauth-token.js";
import { launchDefaultBrowser, launchDetached } from "../../src/shared/oauth.js";
import { platformLayer } from "../../src/shared/platform.js";

const temporaryDirectories: Array<string> = [];
const marker = "synthetic-secret-marker";

const loadCredential = (stateDirectory: string) =>
  Effect.runPromise(loadCredentialEffect(stateDirectory).pipe(Effect.provide(platformLayer)));
const writeCredential = (
  stateDirectory: string,
  value: Parameters<typeof writeCredentialEffect>[1],
) =>
  Effect.runPromise(
    writeCredentialEffect(stateDirectory, value).pipe(Effect.provide(platformLayer)),
  );

const login = (options: Parameters<typeof loginEffect>[0]) =>
  Effect.runPromise(loginEffect(options));

const credential = (suffix: string) => ({
  type: "oauth" as const,
  access: `${marker}-access-${suffix}`,
  refresh: `${marker}-refresh-${suffix}`,
  expires: 1,
  accountId: `account-${suffix}`,
});

const directory = async () => {
  const value = await mkdtemp(join(tmpdir(), "mitome-codex-"));
  temporaryDirectories.push(value);
  return value;
};

// Real Codex access tokens nest the account under this claim.
const accessToken = (claims: Schema.Json) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const jwt = (accountId: string) =>
  accessToken({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });

const callbackPort = async (): Promise<number> => {
  const server = await serve({ fetch: () => new Response() });
  const port = server.port;
  await server.stop(true);
  return port;
};

const tokenServer = async () => {
  const requests: Array<Record<string, string>> = [];
  const server = await serve({
    async fetch(request) {
      const form = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
        Object.fromEntries(await request.formData()),
      );
      requests.push(form);
      return Response.json({
        access_token: jwt("fixture-account"),
        refresh_token: `${marker}-refresh-issued`,
        expires_in: 60,
      });
    },
  });
  return { server, requests };
};

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe("Codex OAuth", () => {
  test("carries a provider-owned OAuth capability without starting transport", () => {
    expect(Provider.credentialDescriptor(codex())).toEqual({
      capability: { module: expect.any(String) },
    });
  });

  test("uses documented PKCE parameters and stores a callback Credential", async () => {
    const stateDirectory = await directory();
    const { server, requests } = await tokenServer();
    const port = await callbackPort();
    let authorization = "";
    const printed: Array<string> = [];
    try {
      await login({
        stateDirectory,
        callbackPort: port,
        tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
        openBrowser: (url) => {
          authorization = url;
          const state = new URL(url).searchParams.get("state")!;
          void fetch(`http://localhost:${port}/auth/callback?code=${marker}-code&state=${state}`);
        },
        input: Effect.never,
        output: (text) => printed.push(text),
      });
      expect(printed.join("")).toContain(authorization);
      const url = new URL(authorization);
      expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        code_challenge_method: "S256",
        originator: "mitome",
        redirect_uri: `http://localhost:${port}/auth/callback`,
        scope: "openid profile email offline_access",
      });
      expect(url.searchParams.get("state")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(requests).toEqual([
        expect.objectContaining({
          grant_type: "authorization_code",
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          code: `${marker}-code`,
          redirect_uri: `http://localhost:${port}/auth/callback`,
        }),
      ]);
      // SAFETY: the preceding equality asserts that the token server received exactly one request.
      expect(requests[0]!.code_verifier).toBeTruthy();
      expect(url.searchParams.get("code_challenge")).toBe(
        Buffer.from(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(requests[0]!.code_verifier),
          ),
        ).toString("base64url"),
      );
      expect(JSON.parse(await readFile(join(stateDirectory, "auth.json"), "utf8"))).toEqual({
        "openai-codex": expect.objectContaining({ type: "oauth", accountId: "fixture-account" }),
      });
    } finally {
      void server.stop(true);
    }
  });

  test("fails a redirected code exchange: the second origin receives nothing", async () => {
    const stateDirectory = await directory();
    const { server: destination, requests } = await tokenServer();
    const redirecting = await serve({
      fetch: () =>
        new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${destination.port}/oauth/token` },
        }),
    });
    const port = await callbackPort();
    try {
      await expect(
        login({
          stateDirectory,
          callbackPort: port,
          tokenUrl: `http://127.0.0.1:${redirecting.port}/oauth/token`,
          openBrowser: (url) => {
            const state = new URL(url).searchParams.get("state")!;
            void fetch(`http://localhost:${port}/auth/callback?code=${marker}-code&state=${state}`);
          },
          input: Effect.never,
          output: () => {},
        }),
      ).rejects.toThrow("OAuth token exchange failed (HTTP 307).");
      expect(requests).toEqual([]);
      await expect(stat(join(stateDirectory, "auth.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      void redirecting.stop(true);
      void destination.stop(true);
    }
  });

  test("answers a malformed callback request with 400 and still completes the login", async () => {
    const stateDirectory = await directory();
    const { server, requests } = await tokenServer();
    const port = await callbackPort();
    const malformed = () =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(port, "localhost");
        let answer = "";
        socket.on("data", (chunk) => (answer += chunk.toString()));
        socket.on("end", () => resolve(answer));
        socket.on("error", reject);
        socket.end("GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      });
    let answer = "";
    try {
      await login({
        stateDirectory,
        callbackPort: port,
        tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
        openBrowser: async (url) => {
          answer = await malformed();
          const state = new URL(url).searchParams.get("state")!;
          void fetch(`http://localhost:${port}/auth/callback?code=${marker}-code&state=${state}`);
        },
        input: Effect.never,
        output: () => {},
      });
      expect(answer).toMatch(/^HTTP\/1\.1 400 /);
      expect(requests).toEqual([expect.objectContaining({ code: `${marker}-code` })]);
    } finally {
      void server.stop(true);
    }
  });

  test("closes the callback server and stops reading input when the login is interrupted", async () => {
    const port = await callbackPort();
    const reading = Promise.withResolvers<void>();
    let stoppedReading = false;
    const fiber = Effect.runFork(
      loginEffect({
        stateDirectory: await directory(),
        callbackPort: port,
        tokenUrl: "http://127.0.0.1:9/oauth/token",
        openBrowser: false,
        input: Effect.callback<string | undefined>(() => {
          reading.resolve();
          return Effect.sync(() => {
            stoppedReading = true;
          });
        }),
        output: () => {},
      }),
    );
    await reading.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(stoppedReading).toBe(true);
    await expect(fetch(`http://localhost:${port}/auth/callback`)).rejects.toThrow(TypeError);
  });

  test("hands the whole OAuth URL to the native Windows launcher", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const launch = vi.fn((_command: string, _args: ReadonlyArray<string>) => Effect.void);
    try {
      const url = "https://auth.openai.com/oauth/authorize?client_id=x&state=y";
      await Effect.runPromise(
        launchDefaultBrowser(url, launch).pipe(Effect.provide(platformLayer)),
      );
      expect(launch).toHaveBeenCalledWith("rundll32", ["url.dll,FileProtocolHandler", url]);
    } finally {
      platform.mockRestore();
    }
  });

  test.skipIf(process.platform === "win32")(
    "leaves what a launcher started running when the launcher fails, and ignores a missing one",
    async () => {
      const at = await directory();
      const pidFile = join(at, "pid");
      const go = join(at, "go");
      const alive = join(at, "alive");
      const launch = (command: string, args: ReadonlyArray<string>) =>
        Effect.runPromise(launchDetached(command, args).pipe(Effect.provide(platformLayer)));
      // As `xdg-open` can: start the program in the background, then exit with a failure. The
      // program answers only once asked, so it must still be running then: a process that was
      // killed but not yet reaped would still have a process id.
      // Bounded, so that it ends by itself if this test never asks.
      const program = `n=0; while [ ! -e "${go}" ] && [ $n -lt 200 ]; do sleep 0.05; n=$((n+1)); done; [ -e "${go}" ] && echo yes > "${alive}"`;
      await launch("/bin/sh", ["-c", `(${program}) & echo $! > "${pidFile}"; exit 1`]);
      const pid = await vi.waitFor(async () => {
        const started = Number(await readFile(pidFile, "utf8"));
        expect(started).toBeGreaterThan(0);
        return started;
      });
      // Long enough for the launcher's exit to have been handled.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      await writeFile(go, "");
      await vi.waitFor(async () => expect(await readFile(alive, "utf8")).toBe("yes\n"));
      expect(pid).toBeGreaterThan(0);
      await launch(join(await directory(), "no-such-launcher"), []);
    },
  );

  test("surfaces a same-state cancelled authorization instead of waiting", async () => {
    const stateDirectory = await directory();
    const { server } = await tokenServer();
    const port = await callbackPort();
    try {
      await expect(
        login({
          stateDirectory,
          callbackPort: port,
          tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
          openBrowser: (url) => {
            const state = new URL(url).searchParams.get("state")!;
            // login rejects and closes the server mid-response; only delivery matters.
            void fetch(
              `http://localhost:${port}/auth/callback?error=access_denied&state=${state}`,
            ).catch(() => {});
          },
          input: Effect.never,
          output: () => {},
        }),
      ).rejects.toThrow("OAuth callback did not include a code");
    } finally {
      void server.stop(true);
    }
  });

  test("observes a cancellation that arrives while an async browser opener is pending", async () => {
    const stateDirectory = await directory();
    const { server } = await tokenServer();
    const port = await callbackPort();
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled += 1;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        login({
          stateDirectory,
          callbackPort: port,
          tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
          openBrowser: async (url) => {
            const state = new URL(url).searchParams.get("state")!;
            await fetch(
              `http://localhost:${port}/auth/callback?error=access_denied&state=${state}`,
            );
            // Stay pending past the point where Node reports an unobserved rejection.
            await new Promise((resolve) => {
              setTimeout(resolve, 50);
            });
          },
          input: Effect.never,
          output: () => {},
        }),
      ).rejects.toThrow("OAuth callback did not include a code");
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      void server.stop(true);
    }
  });

  test("falls back to a pasted redirect and rejects mismatched state", async () => {
    const stateDirectory = await directory();
    const { server } = await tokenServer();
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "localhost", resolve);
    });
    const address = occupied.address();
    if (address === null || Schema.is(Schema.String)(address)) {
      throw new Error("Expected TCP address");
    }
    const occupiedPort = address.port;
    let state = "";
    const output: Array<string> = [];
    try {
      await login({
        stateDirectory,
        callbackPort: occupiedPort,
        tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
        openBrowser: (url) => {
          state = new URL(url).searchParams.get("state")!;
        },
        input: Effect.sync(
          () => `http://localhost:${occupiedPort}/auth/callback?code=${marker}-code&state=${state}`,
        ),
        output: (text) => output.push(text),
      });
      expect(output.join("")).toContain(`Callback port ${occupiedPort} is busy`);
      await expect(
        login({
          stateDirectory,
          callbackPort: occupiedPort,
          tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
          openBrowser: false,
          input: Effect.sync(() => `${marker}-raw-code`),
          output: () => {},
        }),
      ).rejects.toThrow("Invalid URL");
      await expect(
        login({
          stateDirectory,
          callbackPort: occupiedPort,
          tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
          openBrowser: () => {},
          input: Effect.sync(
            () => `http://localhost:${occupiedPort}/auth/callback?code=${marker}-code&state=wrong`,
          ),
          output: () => {},
        }),
      ).rejects.toThrow("OAuth callback state did not match");
      await expect(
        login({
          stateDirectory,
          callbackPort: occupiedPort,
          tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
          openBrowser: (url) => {
            state = new URL(url).searchParams.get("state")!;
          },
          input: Effect.sync(() => `http://localhost:${occupiedPort}/auth/callback?state=${state}`),
          output: () => {},
        }),
      ).rejects.toThrow("OAuth callback did not include a code");
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      void server.stop(true);
    }
  });

  test("logout removes only the Codex entry", async () => {
    const stateDirectory = await directory();
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      join(stateDirectory, "auth.json"),
      JSON.stringify({ other: { retained: true } }),
    );
    await writeCredential(stateDirectory, credential("codex"));
    expect(JSON.parse(await readFile(join(stateDirectory, "auth.json"), "utf8"))).toEqual({
      other: { retained: true },
      "openai-codex": credential("codex"),
    });

    await Effect.runPromise(logout({ stateDirectory, output: () => {} }));
    expect(JSON.parse(await readFile(join(stateDirectory, "auth.json"), "utf8"))).toEqual({
      other: { retained: true },
    });
  });

  test("names the recovery for an absent or malformed Credential", async () => {
    const message =
      "Codex Credential is unavailable. Authenticate through your application; with the Mitome CLI, run `mitome auth login --provider openai-codex`.";
    await expect(loadCredential(await directory())).rejects.toThrow(message);

    const stateDirectory = await directory();
    await writeFile(
      join(stateDirectory, "auth.json"),
      JSON.stringify({ "openai-codex": { ...credential("malformed"), expires: "soon" } }),
    );
    await expect(loadCredential(stateDirectory)).rejects.toThrow(message);
  });

  test("decodes account claims without bypassing an authoritative nested claim", () => {
    expect(accountId(accessToken({ chatgpt_account_id: "top-level" }))).toBe("top-level");
    expect(() =>
      accountId(
        accessToken({
          "https://api.openai.com/auth": {},
          chatgpt_account_id: "must-not-fallback",
        }),
      ),
    ).toThrow("OAuth access token did not contain an account.");
    expect(() => accountId(accessToken([]))).toThrow(
      "OAuth access token did not contain an account.",
    );
  });

  test("never emits authorization or Credential values", async () => {
    const stateDirectory = await directory();
    const { server } = await tokenServer();
    let state = "";
    const output: Array<string> = [];
    try {
      await login({
        stateDirectory,
        callbackPort: 0,
        tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
        openBrowser: (url) => {
          state = new URL(url).searchParams.get("state")!;
        },
        input: Effect.sync(
          () => `http://localhost:0/auth/callback?code=${marker}-code&state=${state}`,
        ),
        output: (text) => output.push(text),
      });
      expect(output.join("")).not.toContain(marker);
    } finally {
      void server.stop(true);
    }
  });
});
