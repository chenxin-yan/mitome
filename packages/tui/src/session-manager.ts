import { createSession } from "@mitome/core";
import type {
  AgentDefinitionError,
  HostContext,
  StoreError,
  TranscriptId,
  TranscriptNotFound,
  TranscriptStore,
  TurnError,
} from "@mitome/core";
import { Effect, Exit, Scope } from "effect";
import type { SessionHandle } from "./view-model.js";

export interface SessionResource extends SessionHandle {
  readonly close: Effect.Effect<void>;
}

export type SessionManagerError =
  | AgentDefinitionError
  | StoreError
  | TranscriptNotFound
  | TurnError;

export interface SessionManager {
  readonly transcripts?: TranscriptStore | undefined;
  readonly open: (
    transcriptId?: TranscriptId,
  ) => Effect.Effect<SessionResource, SessionManagerError>;
}

export const makeSessionManager = (context: HostContext): SessionManager => ({
  transcripts: context.transcripts,
  open: (transcriptId) =>
    Effect.gen(function* () {
      const transcripts = context.transcripts;
      // Direct manager callers can bypass the picker invariant that resume ids require a store.
      if (transcriptId !== undefined && transcripts === undefined) {
        return yield* Effect.die(
          new Error("Cannot resume a Transcript without a Transcript store."),
        );
      }
      const transcript =
        transcriptId === undefined || transcripts === undefined
          ? undefined
          : yield* transcripts.load(transcriptId);
      const scope = yield* Scope.make();
      const session = yield* Scope.provide(scope)(
        createSession(context.agent, { transcripts, transcript }),
      ).pipe(Effect.tapCause((cause) => Scope.close(scope, Exit.failCause(cause))));
      return {
        ...session,
        close: Scope.close(scope, Exit.void),
      };
    }),
});
