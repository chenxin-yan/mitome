import { createSession } from "@mitome/core";
import type {
  AgentDefinitionError,
  HostContext,
  Session,
  StoreError,
  TranscriptId,
  TranscriptNotFound,
  TranscriptStore,
  TurnError,
} from "@mitome/core";
import { Effect, Exit, Scope } from "effect";

export interface SessionResource extends Pick<Session, "runTurn" | "history"> {
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
      const transcript =
        transcriptId === undefined || transcripts === undefined
          ? undefined
          : yield* transcripts.load(transcriptId);
      const scope = yield* Scope.make();
      const session = yield* Scope.provide(scope)(
        createSession(context.agent, { transcripts, transcript }),
      ).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))));
      return {
        ...session,
        close: Scope.close(scope, Exit.void),
      };
    }),
});
