import { spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { AgentDefinition, AnyExtension, AnyProvider } from "@mitome/core";
import { Schema } from "effect";

type SseData = string | typeof Schema.Json.Type;

export const sse = (data: SseData) =>
  `data: ${Schema.is(Schema.String)(data) ? data : JSON.stringify(data)}\n\n`;

export const agent = (
  provider: AnyProvider,
  model: string,
  extensions: ReadonlyArray<AnyExtension> = [],
): AgentDefinition => ({
  providers: [provider],
  model: `${provider.id}/${model}`,
  extensions,
});

interface ServerOptions {
  readonly fetch: (request: Request) => Response | Promise<Response>;
}

interface TestServer {
  readonly port: number;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

const headers = (value: IncomingHttpHeaders): Array<[string, string]> =>
  Object.entries(value).flatMap(([name, header]) =>
    header === undefined ? [] : [[name, Array.isArray(header) ? header.join(", ") : header]],
  );

export const serve = async ({ fetch }: ServerOptions): Promise<TestServer> => {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const chunks: Array<Uint8Array> = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const init =
          body.length === 0
            ? { method: incoming.method ?? "GET", headers: headers(incoming.headers) }
            : { method: incoming.method ?? "GET", headers: headers(incoming.headers), body };
        const request = new Request(`http://${incoming.headers.host}${incoming.url}`, init);
        const response = await fetch(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body === null) {
          outgoing.end();
          return;
        }
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          outgoing.write(value);
        }
        outgoing.end();
      } catch {
        outgoing.writeHead(500).end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    // SAFETY: a successfully listening TCP server returns AddressInfo rather than null or a pipe name.
    port: (server.address() as AddressInfo).port,
    stop: (closeActiveConnections = false) => {
      if (closeActiveConnections) server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
};

export const spawnRuntime = (args: ReadonlyArray<string>) => {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  return {
    exited: new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    }),
    stderr: Readable.toWeb(child.stderr),
  };
};
