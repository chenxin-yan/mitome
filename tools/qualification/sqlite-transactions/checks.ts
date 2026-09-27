// Transaction checks for the repository-installed SQLite adapters (development-only patch).
// Run under each real runtime: `bun checks.ts` uses @effect/sql-sqlite-bun with bun:sqlite,
// `node checks.ts` uses @effect/sql-sqlite-node with node:sqlite. Expected exit 0 on both;
// any failed assertion exits nonzero. Bun sets process.versions.bun; its process.version is not Node.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import {
  ConnectionError,
  ConstraintError,
  LockTimeoutError,
  SqlError,
} from "effect/unstable/sql/SqlError";

interface PeerDatabase {
  readonly exec: (statement: string) => void;
  readonly count: (table: string) => number;
  readonly sqliteVersion: string;
  readonly close: () => void;
}

// bun-types declares process.versions.bun on every runtime, so test for the key itself.
const isBun = Object.hasOwn(process.versions, "bun");
const adapterName = isBun ? "@effect/sql-sqlite-bun" : "@effect/sql-sqlite-node";
const Driver = isBun
  ? await import("@effect/sql-sqlite-bun/SqliteClient")
  : await import("@effect/sql-sqlite-node/SqliteClient");

const openPeer = async (filename: string): Promise<PeerDatabase> => {
  if (isBun) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(filename);
    const scalar = (query: string) => Number(db.query<{ n: number }, []>(query).get()?.n);

    return {
      exec: (statement) => db.run(statement),
      count: (table) => scalar(`SELECT count(*) AS n FROM ${table}`),
      sqliteVersion: String(db.query<{ v: string }, []>("SELECT sqlite_version() AS v").get()?.v),
      close: () => db.close(),
    };
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(filename);
  const scalar = (query: string) => Number(db.prepare(query).get()?.["n"]);

  return {
    exec: (statement) => db.exec(statement),
    count: (table) => scalar(`SELECT count(*) AS n FROM ${table}`),
    sqliteVersion: String(db.prepare("SELECT sqlite_version() AS v").get()?.["v"]),
    close: () => db.close(),
  };
};

// SQLITE_BUSY from the peer means the adapter connection still holds the write lock.
const peerCanWrite = (peer: PeerDatabase) => {
  try {
    peer.exec("BEGIN IMMEDIATE");
    peer.exec("ROLLBACK");
    return true;
  } catch (error) {
    assert.ok(error instanceof Error && /database is locked/i.test(error.message), String(error));
    return false;
  }
};

const sqlReasons = <E>(cause: Cause.Cause<E>) =>
  cause.reasons.flatMap((reason) => {
    if (Cause.isDieReason(reason)) {
      return reason.defect instanceof SqlError
        ? [{ kind: "die", reason: reason.defect.reason }]
        : [];
    }

    if (Cause.isFailReason(reason)) {
      return reason.error instanceof SqlError
        ? [{ kind: "fail", reason: reason.error.reason }]
        : [];
    }

    return [];
  });

const check = <E>(name: string, body: Effect.Effect<void, E>) =>
  Effect.andThen(
    body,
    Effect.sync(() => console.log(`PASS ${name}`)),
  );

const effectPackage = fileURLToPath(import.meta.resolve("effect/package.json"));
const adapterModule = fileURLToPath(import.meta.resolve(`${adapterName}/SqliteClient`));
const adapterEffectPackage = createRequire(adapterModule).resolve("effect/package.json");
const directory = mkdtempSync(join(tmpdir(), "mitome-sqlite-transactions-"));
const filename = join(directory, "checks.sqlite");
const peer = await openPeer(filename);

console.log(
  JSON.stringify({
    runtime: isBun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
    sqlite: peer.sqliteVersion,
    adapter: realpathSync(adapterModule),
    effect: realpathSync(effectPackage),
    sqlClient: realpathSync(fileURLToPath(import.meta.resolve("effect/unstable/sql/SqlClient"))),
    database: filename,
  }),
);

assert.equal(
  realpathSync(adapterEffectPackage),
  realpathSync(effectPackage),
  "the adapter must resolve the same effect package as the repository",
);
console.log("PASS the adapter resolves the same effect package as the repository");

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const childRows = Effect.map(
    sql<{ n: number }>`SELECT count(*) AS n FROM child`,
    ([row]) => row?.n,
  );
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`;
  yield* sql`CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`;
  yield* sql`CREATE TABLE controls (id INTEGER PRIMARY KEY)`;
  yield* sql`INSERT INTO parent VALUES (1)`;
  peer.exec("PRAGMA busy_timeout = 0");

  yield* check(
    "a committed transaction is visible to another connection",
    Effect.gen(function* () {
      const exit = yield* Effect.exit(sql.withTransaction(sql`INSERT INTO controls VALUES (1)`));
      assert.ok(Exit.isSuccess(exit));
      assert.equal(peer.count("controls"), 1);
    }),
  );

  yield* check(
    "a failed body rolls back and keeps its own failure",
    Effect.gen(function* () {
      const failure = new Error("body failed after insert");
      const exit = yield* Effect.exit(
        sql.withTransaction(
          Effect.andThen(sql`INSERT INTO controls VALUES (2)`, Effect.fail(failure)),
        ),
      );
      assert.ok(Exit.isFailure(exit));
      assert.equal(Cause.squash(exit.cause), failure);
      assert.equal(Cause.hasDies(exit.cause), false);
      assert.equal(peer.count("controls"), 1);
    }),
  );

  yield* check(
    "a busy BEGIN fails as a lock timeout before the body runs",
    Effect.gen(function* () {
      let bodyRan = false;
      peer.exec("BEGIN IMMEDIATE");
      const exit = yield* Effect.exit(
        sql.withTransaction(
          Effect.sync(() => {
            bodyRan = true;
          }),
        ),
      ).pipe(Effect.ensuring(Effect.sync(() => peer.exec("ROLLBACK"))));
      assert.ok(Exit.isFailure(exit));
      assert.equal(bodyRan, false);
      assert.equal(Cause.hasDies(exit.cause), false);
      const [reason] = sqlReasons(exit.cause);
      assert.ok(reason?.kind === "fail" && reason.reason instanceof LockTimeoutError);
    }),
  );

  for (const attempt of [1, 2]) {
    yield* check(
      `failed deferred-FK COMMIT ${attempt} leaves no row or lock and the next transaction commits`,
      Effect.gen(function* () {
        const failed = yield* Effect.exit(
          sql.withTransaction(sql`INSERT INTO child VALUES (${attempt}, 999)`),
        );
        assert.ok(Exit.isFailure(failed));
        const reasons = sqlReasons(failed.cause);
        assert.equal(reasons.length, 1);
        assert.ok(reasons[0]?.kind === "die" && reasons[0].reason instanceof ConstraintError);
        assert.match(Cause.pretty(failed.cause), /foreign key constraint failed/i);
        assert.equal(
          yield* childRows,
          0,
          "failed COMMIT row must be absent on the reused connection",
        );
        assert.equal(peerCanWrite(peer), true, "failed COMMIT must release the write lock");

        let bodyRan = false;
        const next = yield* Effect.exit(
          sql.withTransaction(
            Effect.andThen(
              Effect.sync(() => {
                bodyRan = true;
              }),
              sql`INSERT INTO controls VALUES (${10 + attempt})`,
            ),
          ),
        );
        assert.ok(Exit.isSuccess(next), "the next valid transaction must commit");
        assert.equal(bodyRan, true);
        assert.equal(peer.count("controls"), 1 + attempt);
      }),
    );
  }

  // Synthetic failure at the Connection method, not SQLite I/O. Reserve lends the same
  // connection that transactions use; only the cleanup ROLLBACK is failed.
  const conn: Connection = yield* Effect.scoped(sql.reserve);
  const executeUnprepared = conn.executeUnprepared.bind(conn);
  const rollbacks: Array<string> = [];
  let failRollback = true;
  const injected: Connection["executeUnprepared"] = (statement, params, transformRows) => {
    if (statement !== "ROLLBACK") return executeUnprepared(statement, params, transformRows);
    rollbacks.push(failRollback ? "injected-failure" : "real");
    return failRollback
      ? Effect.fail(
          new SqlError({
            reason: new ConnectionError({
              message: "injected rollback failure",
              operation: "rollback",
              cause: new Error("injected rollback failure"),
            }),
          }),
        )
      : executeUnprepared(statement, params, transformRows);
  };
  Object.defineProperty(conn, "executeUnprepared", { configurable: true, value: injected });

  yield* check(
    "a failed cleanup ROLLBACK keeps both failures and refuses the dirty connection until cleanup succeeds",
    Effect.gen(function* () {
      const failed = yield* Effect.exit(
        sql.withTransaction(sql`INSERT INTO child VALUES (50, 999)`),
      );
      assert.ok(Exit.isFailure(failed));
      const reasons = sqlReasons(failed.cause);
      assert.equal(reasons.length, 2, "COMMIT and cleanup failures must both stay visible");
      assert.ok(reasons[0]?.kind === "die" && reasons[0].reason instanceof ConstraintError);
      assert.ok(reasons[1]?.kind === "die" && reasons[1].reason instanceof ConnectionError);
      assert.equal(peerCanWrite(peer), false, "the fixture must leave a dirty connection");

      for (const round of [1, 2]) {
        let bodyRan = false;
        const query = yield* Effect.exit(Effect.asVoid(childRows));
        const transaction = yield* Effect.exit(
          sql.withTransaction(
            Effect.sync(() => {
              bodyRan = true;
            }),
          ),
        );
        for (const exit of [query, transaction]) {
          assert.ok(Exit.isFailure(exit), `round ${round}: the dirty connection must be refused`);
          assert.match(Cause.pretty(exit.cause), /cannot be reused after failed COMMIT cleanup/i);
        }
        assert.equal(bodyRan, false);
      }
      assert.deepEqual(
        rollbacks,
        Array.from({ length: 5 }, () => "injected-failure"),
      );

      failRollback = false;
      assert.equal(yield* childRows, 0);
      assert.equal(peerCanWrite(peer), true);
      const next = yield* Effect.exit(sql.withTransaction(sql`INSERT INTO child VALUES (51, 1)`));
      assert.ok(Exit.isSuccess(next));
      assert.equal(peer.count("child"), 1);
      assert.deepEqual(rollbacks.slice(5), ["real"]);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() =>
          Object.defineProperty(conn, "executeUnprepared", {
            configurable: true,
            value: executeUnprepared,
          }),
        ),
      ),
    ),
  );
});

try {
  await Effect.runPromise(program.pipe(Effect.provide(Driver.layer({ filename, busyTimeout: 0 }))));
} finally {
  peer.close();
  rmSync(directory, { recursive: true, force: true });
}
