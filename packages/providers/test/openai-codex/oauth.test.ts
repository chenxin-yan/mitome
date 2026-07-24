import { afterAll, describe, expect, test } from "vitest";
import { setTimeout } from "node:timers/promises";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { credentialDescriptor } from "@mitome/core";
import { serve, spawnRuntime } from "../support.js";
import { codex, login, logout, writeCredential } from "../../src/openai-codex/index.js";

const temporaryDirectories: Array<string> = [];
const marker = "synthetic-secret-marker";

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
const jwt = (accountId: string) =>
  `header.${Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url")}.signature`;

const callbackPort = async (): Promise<number> => {
  const server = await serve({ fetch: () => new Response() });
  const port = server.port!;
  await server.stop(true);
  return port;
};

const tokenServer = async () => {
  const requests: Array<Record<string, string>> = [];
  const server = await serve({
    async fetch(request) {
      const form = Object.fromEntries(await request.formData()) as Record<string, string>;
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
    expect(credentialDescriptor(codex())).toEqual({
      capability: { module: expect.any(String) },
    });
  });

  test("uses documented PKCE parameters and stores a callback Credential", async () => {
    const configDirectory = await directory();
    const { server, requests } = await tokenServer();
    const port = await callbackPort();
    let authorization = "";
    try {
      await login({
        configDirectory,
        callbackPort: port,
        tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
        openBrowser: (url) => {
          authorization = url;
          const state = new URL(url).searchParams.get("state")!;
          void fetch(`http://localhost:${port}/auth/callback?code=${marker}-code&state=${state}`);
        },
        input: async () => new Promise(() => {}),
        output: () => {},
      });
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
      expect(requests[0]!.code_verifier).toBeTruthy();
      expect(url.searchParams.get("code_challenge")).toBe(
        Buffer.from(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(requests[0]!.code_verifier!),
          ),
        ).toString("base64url"),
      );
      expect((await stat(join(configDirectory, "auth.json"))).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(join(configDirectory, "auth.json"), "utf8"))).toEqual({
        "openai-codex": expect.objectContaining({ type: "oauth", accountId: "fixture-account" }),
      });
    } finally {
      void server.stop(true);
    }
  });

  test("surfaces a same-state cancelled authorization instead of waiting", async () => {
    const configDirectory = await directory();
    const { server } = await tokenServer();
    const port = await callbackPort();
    try {
      await expect(
        login({
          configDirectory,
          callbackPort: port,
          tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
          openBrowser: (url) => {
            const state = new URL(url).searchParams.get("state")!;
            // login rejects and closes the server mid-response; only delivery matters.
            void fetch(
              `http://localhost:${port}/auth/callback?error=access_denied&state=${state}`,
            ).catch(() => {});
          },
          input: async () => new Promise(() => {}),
          output: () => {},
        }),
      ).rejects.toThrow("OAuth callback did not include a code");
    } finally {
      void server.stop(true);
    }
  });

  test("falls back to a pasted redirect and rejects mismatched state", async () => {
    const configDirectory = await directory();
    const { server } = await tokenServer();
    const occupied = await serve({ fetch: () => new Response("occupied") });
    const occupiedPort = occupied.port!;
    let state = "";
    try {
      await login({
        configDirectory,
        callbackPort: occupiedPort,
        tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
        openBrowser: (url) => {
          state = new URL(url).searchParams.get("state")!;
        },
        input: async () =>
          `http://localhost:${occupiedPort}/auth/callback?code=${marker}-code&state=${state}`,
        output: () => {},
      });
      await expect(
        login({
          configDirectory,
          callbackPort: occupiedPort,
          tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
          openBrowser: false,
          input: async () => `${marker}-raw-code`,
          output: () => {},
        }),
      ).rejects.toThrow();
      await expect(
        login({
          configDirectory,
          callbackPort: occupiedPort,
          tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
          openBrowser: () => {},
          input: async () =>
            `http://localhost:${occupiedPort}/auth/callback?code=${marker}-code&state=wrong`,
          output: () => {},
        }),
      ).rejects.toThrow("OAuth callback state did not match");
      await expect(
        login({
          configDirectory,
          callbackPort: occupiedPort,
          tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
          openBrowser: (url) => {
            state = new URL(url).searchParams.get("state")!;
          },
          input: async () => `http://localhost:${occupiedPort}/auth/callback?state=${state}`,
          output: () => {},
        }),
      ).rejects.toThrow("OAuth callback did not include a code");
    } finally {
      void occupied.stop(true);
      void server.stop(true);
    }
  });

  test("serializes atomic cross-process writes and logout preserves unrelated entries", async () => {
    const configDirectory = await directory();
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "auth.json"),
      JSON.stringify({ other: { retained: true } }),
    );
    const source = new URL("../../dist/openai-codex/index.js", import.meta.url).href;
    const writer = (providerKey: string) =>
      spawnRuntime([
        "-e",
        `const { writeCredential } = await import(${JSON.stringify(source)}); await writeCredential(${JSON.stringify(configDirectory)}, ${JSON.stringify(providerKey)}, ${JSON.stringify(credential(providerKey))});`,
      ]);
    const writers = [writer("first"), writer("second")];
    expect(await Promise.all(writers.map((writer) => writer.exited))).toEqual([0, 0]);
    const contents = await readFile(join(configDirectory, "auth.json"), "utf8");
    expect(JSON.parse(contents)).toMatchObject({
      other: { retained: true },
      first: { type: "oauth" },
      second: { type: "oauth" },
    });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeCredential(configDirectory, "openai-codex", credential(String(index))),
      ),
    );
    await logout({ configDirectory, output: () => {} });
    expect(JSON.parse(await readFile(join(configDirectory, "auth.json"), "utf8"))).toMatchObject({
      other: { retained: true },
      first: { type: "oauth" },
      second: { type: "oauth" },
    });
    expect((await stat(join(configDirectory, "auth.json"))).mode & 0o777).toBe(0o600);
  });

  test("does not reap a stale storage lock", async () => {
    const configDirectory = await directory();
    await mkdir(configDirectory, { recursive: true });
    const lock = join(configDirectory, "auth.lock");
    await writeFile(lock, "");
    const stale = new Date(Date.now() - 31_000);
    await utimes(lock, stale, stale);

    const write = writeCredential(configDirectory, "other", credential("stale"));
    await setTimeout(50);
    expect(await readFile(lock, "utf8")).toBe("");

    await rm(lock);
    await write;
    expect(JSON.parse(await readFile(join(configDirectory, "auth.json"), "utf8"))).toMatchObject({
      other: { type: "oauth" },
    });
  });

  test("never emits authorization or Credential values", async () => {
    const configDirectory = await directory();
    const { server } = await tokenServer();
    let state = "";
    const output: Array<string> = [];
    try {
      await login({
        configDirectory,
        callbackPort: 0,
        tokenUrl: `http://127.0.0.1:${server.port}/oauth/token`,
        openBrowser: (url) => {
          state = new URL(url).searchParams.get("state")!;
        },
        input: async () => `http://localhost:0/auth/callback?code=${marker}-code&state=${state}`,
        output: (text) => output.push(text),
      });
      expect(output.join("")).not.toContain(marker);
    } finally {
      void server.stop(true);
    }
  });
});
