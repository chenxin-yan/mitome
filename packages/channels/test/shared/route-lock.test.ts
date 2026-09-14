import { describe, expect, it } from "@effect/vitest";
import type { RouteKey } from "@mitome/core";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { createRouteLock, RouteBusyError } from "../../src/shared/route-lock.js";

const key: RouteKey = { channel: "http", principal: "alice", conversation: "chat-1" };
const otherConversation: RouteKey = { ...key, conversation: "chat-2" };

describe("Route lock", () => {
  it.effect("fails an overlapping Turn on the same Route and leaves other Routes free", () =>
    Effect.gen(function* () {
      const withLock = createRouteLock();
      const release = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(withLock(key, Deferred.await(release)));
      yield* Effect.yieldNow;

      const overlap = yield* Effect.exit(withLock(key, Effect.succeed("second")));
      expect(overlap).toEqual(Exit.fail(new RouteBusyError({ key })));
      expect(yield* withLock(otherConversation, Effect.succeed("other"))).toBe("other");

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      expect(yield* withLock(key, Effect.succeed("after"))).toBe("after");
    }),
  );

  it.effect("releases the Route after a failed or interrupted Turn", () =>
    Effect.gen(function* () {
      const withLock = createRouteLock();
      yield* Effect.exit(withLock(key, Effect.fail("model down")));
      expect(yield* withLock(key, Effect.succeed("after failure"))).toBe("after failure");

      const hung = yield* Effect.forkChild(withLock(key, Effect.never));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(hung);
      expect(yield* withLock(key, Effect.succeed("after interrupt"))).toBe("after interrupt");
    }),
  );
});
