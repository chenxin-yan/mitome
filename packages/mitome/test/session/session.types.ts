// Compile-only fixture: the @ts-expect-error lines are the negative controls, so the language
// service's duplicate context/error diagnostics are skipped here.
// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file missingEffectError:skip-file */
import { Context, Data, Effect, type Scope, type Types } from "effect";
import { Session } from "../../src/kernel.js";
import {
  type SessionBusyError,
  type SessionFencedError,
  type SessionReleasedError,
  type SessionSaveError,
  type TranscriptError,
  Turn,
} from "../../src/index.js";

const exact = <X, Y>(equal: Types.Equals<X, Y>) => equal;

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
    if (other.n > input.limit) {
      return yield* new AppError();
    }
    const result: Result = { answer: 42, invoke: String };
    return result;
  });

declare const transcript: Session.Transcript;
declare const live: Session.Session;
declare const persisted: Session.Session<SessionSaveError | SessionFencedError>;
type Boundary = SessionBusyError | SessionReleasedError;
type Persistence = SessionSaveError | SessionFencedError;

exact<
  typeof application,
  (input: { readonly limit: number }) => Effect.Effect<Result, AppError, Turn | Scope.Scope | Other>
>(true);
const nonDurable = Session.make({ transcript: "none" });
const durable = Session.make({ transcript });
// Limits are optional, and one bound may be given alone.
const oneBound = Session.make({ transcript: "none", limits: { generations: 1 } });
exact<typeof oneBound, typeof nonDurable>(true);
exact<typeof nonDurable, Effect.Effect<Session.Session, never, Scope.Scope>>(true);
exact<typeof durable, Effect.Effect<Session.Session<Persistence>, TranscriptError, Scope.Scope>>(
  true,
);

const direct = live.run(application({ limit: 1 }));
const piped = application({ limit: 1 }).pipe(live.run);
const saved = persisted.run(application({ limit: 1 }));
exact<typeof direct, Effect.Effect<Result, AppError | Boundary, Other>>(true);
exact<typeof piped, typeof direct>(true);
exact<typeof saved, Effect.Effect<Result, AppError | Boundary | Persistence, Other>>(true);
exact<Effect.Success<typeof live.turns>, ReadonlyArray<Session.TurnSnapshot>>(true);
exact<
  Session.TurnSnapshot,
  {
    readonly id: string;
    readonly phase: "running" | "succeeded" | "failed" | "uncertain";
    readonly entries: ReadonlyArray<string>;
  }
>(true);
exact<typeof live.position, Effect.Effect<string | undefined, SessionReleasedError>>(true);
exact<ReturnType<typeof live.moveTo>, Effect.Effect<void, Boundary | TranscriptError>>(true);
exact<
  ReturnType<typeof persisted.moveTo>,
  Effect.Effect<void, Boundary | TranscriptError | Persistence>
>(true);
exact<Parameters<typeof live.moveTo>, [position: string | undefined]>(true);
exact<Effect.Error<typeof live.tree>, SessionReleasedError | TranscriptError>(true);

// The ambient Turn exposes its owning Session, keeping every error a Session can raise.
exact<typeof Turn.Service.session, Session.Session<Persistence>>(true);
exact<
  ReturnType<typeof Turn.Service.session.run<Result, AppError, Other | Turn | Scope.Scope>>,
  Effect.Effect<Result, AppError | Boundary | Persistence, Other>
>(true);

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
const posing: Session.Session = persisted;
// @ts-expect-error The ambient Session's run does not erase its persistence errors.
const ambientRun: Effect.Effect<Result, AppError | Boundary, Other> = Turn.Service.session.run(
  application({ limit: 1 }),
);
// @ts-expect-error Storage must be chosen explicitly.
const unchosen = Session.make({ limits: { generations: 1 } });

void [missingOther, erasedError, erasedSave, otherResult, unmanaged, posing, unchosen];
void ambientRun;
