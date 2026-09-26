// Compile-only fixture: the @ts-expect-error lines are the negative controls, so the language
// service's duplicate context/error diagnostics are skipped here.
// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file missingEffectError:skip-file */
import { Context, Data, Effect, type Scope } from "effect";
import * as Core from "../../src/index.js";
import {
  type Session,
  type SessionBusyError,
  type SessionFencedError,
  type SessionReleasedError,
  type SessionSaveError,
  type SessionStore,
  Turn,
  type TurnSnapshot,
} from "../../src/index.js";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const exact = <X, Y>(equal: Equal<X, Y>) => equal;

class Other extends Context.Service<Other, { readonly n: number }>()("fixture/Other") {}
class AppError extends Data.TaggedError("AppError") {}
interface Result {
  readonly answer: 42;
  readonly invoke: (n: number) => string;
}

const application = (input: { readonly limit: number }) =>
  Effect.gen(function* () {
    const turn = yield* Turn;
    yield* turn.stage();
    yield* Effect.acquireRelease(Effect.succeed("Turn resource"), () => Effect.void);
    const other = yield* Other;
    if (other.n > input.limit) return yield* new AppError();
    const result: Result = { answer: 42, invoke: String };
    return result;
  });

declare const store: SessionStore;
declare const live: Session;
declare const persisted: Session<SessionSaveError | SessionFencedError>;
type Boundary = SessionBusyError | SessionReleasedError;
type Persistence = SessionSaveError | SessionFencedError;

exact<
  typeof application,
  (input: { readonly limit: number }) => Effect.Effect<Result, AppError, Turn | Scope.Scope | Other>
>(true);
const nonDurable = Core.makeSession({ persistence: "none" });
const durable = Core.makeSession({ persistence: store });
exact<typeof nonDurable, Effect.Effect<Session, never, Scope.Scope>>(true);
exact<typeof durable, Effect.Effect<Session<Persistence>, never, Scope.Scope>>(true);

const direct = live.run(application({ limit: 1 }));
const piped = application({ limit: 1 }).pipe(live.run);
const saved = persisted.run(application({ limit: 1 }));
exact<typeof direct, Effect.Effect<Result, AppError | Boundary, Other>>(true);
exact<typeof piped, typeof direct>(true);
exact<typeof saved, Effect.Effect<Result, AppError | Boundary | Persistence, Other>>(true);
exact<Effect.Success<typeof live.turns>, ReadonlyArray<TurnSnapshot>>(true);

// Unrelated requirements stay required until the caller provides them.
const provided: Effect.Effect<Result, AppError | Boundary> = direct.pipe(
  Effect.provideService(Other, { n: 0 }),
);
void provided;

// @ts-expect-error Other is not erased by the Turn.
const missingOther: Effect.Effect<Result, AppError | Boundary> = direct;
// @ts-expect-error Application errors are not erased by the Turn.
const erasedError: Effect.Effect<Result, Boundary, Other> = direct;
// @ts-expect-error Store failures are not erased on a persisted Session.
const erasedSave: Effect.Effect<Result, AppError | Boundary, Other> = saved;
// @ts-expect-error The result keeps its literal type rather than widening.
const otherResult: Effect.Effect<{ readonly answer: 43 }, AppError | Boundary, Other> = direct;
// @ts-expect-error Only Session.run supplies Turn and the Turn Scope.
const unmanaged: Effect.Effect<Result, AppError, Other> = application({ limit: 1 });
// @ts-expect-error A persisted Session cannot pose as one whose Turns never fail to save.
const posing: Session = persisted;
// @ts-expect-error Persistence must be chosen explicitly.
const unchosen = Core.makeSession({});
// @ts-expect-error A live exit is omitted, never present as undefined.
const explicitUndefined: TurnSnapshot = {
  id: "t",
  durability: "non-durable",
  phase: "running",
  exit: undefined,
};

void [missingOther, erasedError, erasedSave, otherResult, unmanaged, posing, unchosen];
void explicitUndefined;
