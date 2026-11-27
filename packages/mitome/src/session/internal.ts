import { type Effect, type Layer, Predicate } from "effect";
import type { LanguageModel, Prompt } from "effect/ai";
import type { CredentialDescriptor } from "./credential.js";
import type {
  ExecutionLimitError,
  SessionFencedError,
  SessionReleasedError,
  SessionSaveError,
} from "./errors.js";
import type { AnyProvider, ModelMetadataMap, Provider } from "./provider.js";
import type { Session } from "./session.js";
import type { ExecutionLimits, Turn } from "./turn.js";

/**
 * Controlled-Step access to a Turn; not part of the public Turn service. Every generation and
 * dispatch first reserves, and `reserve` is a defect once the Turn has ended or its Session is
 * released: a Turn handle that escaped its Turn authorizes nothing. Accounting of requests already
 * sent still records while the Session lives.
 */
export interface TurnControl {
  /**
   * Runs one whole controlled Step while holding this Turn's single Step permit, so Steps of the
   * same Turn run one after another in arrival order. Waiting is interruptible and releases
   * nothing it never took. A fenced Session admits no Step.
   */
  readonly admit: <A, E, R>(
    step: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SessionFencedError, R>;
  /** The Model Context: committed history followed by this Turn's staged Messages. */
  readonly prompt: Effect.Effect<Prompt.Prompt>;
  /**
   * Commits the staged Messages, if any, as one Entry: stored, then published. Uninterruptible
   * once started; Messages a failed commit did not publish stay staged.
   */
  readonly commit: Effect.Effect<void, SessionSaveError | SessionFencedError>;
  /** Reserves one unit, failing without reserving when the bound is already reached. */
  readonly reserve: (limit: keyof ExecutionLimits) => Effect.Effect<void, ExecutionLimitError>;
  readonly addPhysicalRequests: (count: number) => Effect.Effect<void>;
}

export const turnControls = new WeakMap<Turn["Service"], TurnControl>();

/** The controlled-Step access of a Turn `Session.make` created. */
export const turnControl = (turn: Turn["Service"]): TurnControl => {
  const control = turnControls.get(turn);
  if (control === undefined) {
    throw new Error("Turn was not created by Session.make");
  }
  return control;
};

/**
 * Runs work on a fiber its Session's execution Scope owns, as `moveTo` and `tree` do: refused once
 * the Session is released, and interrupted and awaited by its release.
 */
export type SessionOwned = <A, E>(
  effect: Effect.Effect<A, E>,
) => Effect.Effect<A, E | SessionReleasedError>;

export const sessionOwnedWork = new WeakMap<Session<unknown>, SessionOwned>();

/** How to run work a Session made by `Session.make` owns. */
export const sessionOwned = (session: Session<unknown>): SessionOwned => {
  const owned = sessionOwnedWork.get(session);
  if (owned === undefined) {
    throw new Error("Session was not created by Session.make");
  }
  return owned;
};

export interface ProviderMetadata<E, R> {
  readonly credential: CredentialDescriptor | undefined;
  readonly provision: (modelId: string) => Layer.Layer<LanguageModel.LanguageModel, E, R>;
  readonly models: ModelMetadataMap;
}

export const providerMetadata = new WeakMap<object, ProviderMetadata<unknown, unknown>>();

/**
 * Whether a value is a Provider created by this copy of `@mitome/core`. The brand establishes only
 * that: the narrowed Provider's provisioning error and requirements stay unknown, so it cannot be
 * provisioned as if it needed nothing further.
 */
export const isProvider = (value: unknown): value is AnyProvider =>
  Predicate.isObjectKeyword(value) && providerMetadata.has(value);

/**
 * Core-internal access to a Provider's hidden metadata, typed by the Provider's own provisioning
 * error and requirements; absent for Providers Core did not create.
 */
export const getProviderMetadata = <E, R>(
  provider: Provider<string, ReadonlyArray<string>, E, R>,
): ProviderMetadata<E, R> | undefined =>
  // SAFETY: Provider.make stores each Provider's metadata with the provision function that fixed
  // that Provider's E and R, so the entry for this value has exactly these types.
  providerMetadata.get(provider) as ProviderMetadata<E, R> | undefined;

/**
 * Splits a Qualified Model id at its first `/`, leaving later `/` characters in the
 * Provider-native Model id. Returns undefined for anything that cannot select a Model.
 */
export const parseQualifiedModelId = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- parses whatever a Host passes as a Model id; returns its parts, not a narrowed type
  qualifiedModelId: unknown,
): { readonly providerId: string; readonly modelId: string } | undefined => {
  if (!Predicate.isString(qualifiedModelId)) {
    return undefined;
  }
  const separator = qualifiedModelId.indexOf("/");
  if (separator <= 0 || separator === qualifiedModelId.length - 1) {
    return undefined;
  }
  return {
    providerId: qualifiedModelId.slice(0, separator),
    modelId: qualifiedModelId.slice(separator + 1),
  };
};
