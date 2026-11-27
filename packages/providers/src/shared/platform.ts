import { createServer } from "node:http";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Effect, Layer } from "effect";
import type { Scope } from "effect";

/**
 * Effect's file system, path and child-process services, from Node's implementation, which Bun
 * also runs. Provided at the package's boundaries, so a Provider requires nothing of its Host.
 */
export const platformLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
);

// TODO: serve this through Effect's HttpServer once `@effect/platform-node`, which has one, no
// longer requires `redis` (https://github.com/Effect-TS/effect/issues/10927).
/**
 * Serves `respond` on `localhost` at `port` until the Scope closes, answering each request target
 * with the status and text it returns; `false` when another process holds the port. Closing does
 * not wait for open requests, so a client holding one cannot delay whoever closes it.
 */
export const serveLocalhost = (
  port: number,
  respond: (target: string) => readonly [status: number, text: string],
): Effect.Effect<boolean, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() =>
      createServer((request, response) => {
        const [status, text] = respond(request.url ?? "/");
        // A 200 is written as `end` writes it, with its length rather than chunked.
        if (status === 200) {
          response.end(text);
        } else {
          response.writeHead(status).end(text);
        }
      }),
    ),
    (server) => Effect.sync(() => server.close()),
  ).pipe(
    Effect.flatMap((server) =>
      Effect.callback<boolean, Error>((resume) => {
        server.once("error", (error) =>
          // SAFETY: Node http servers emit Error objects whose optional code is the errno.
          resume(
            (error as NodeJS.ErrnoException).code === "EADDRINUSE"
              ? Effect.succeed(false)
              : Effect.fail(error),
          ),
        );
        server.listen(port, "localhost", () => resume(Effect.succeed(true)));
      }),
    ),
  );
