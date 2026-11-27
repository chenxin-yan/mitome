import { Effect, Layer } from "effect";
import type { Types } from "effect";
import { LanguageModel } from "effect/ai";
import { Provider } from "../src/index.js";
import type { AuthCapability, AuthenticateOptions, CredentialDescriptor } from "../src/index.js";

// SAFETY: this compile-only fixture never executes the LanguageModel service.
const layer = Layer.succeed(LanguageModel.LanguageModel, {} as LanguageModel.LanguageModel);
const alpha = Provider.make("alpha", {
  modelIds: ["known", "other"] as const,
  provision: () => layer,
});

// @ts-expect-error Provider ids must be non-empty.
Provider.make("", { modelIds: [], provision: () => layer });
// @ts-expect-error Provider ids cannot contain the Model separator.
Provider.make("invalid/id", { modelIds: [], provision: () => layer });

const known: Provider.QualifiedModelId<typeof alpha> = "alpha/known";
const arbitrary: Provider.QualifiedModelId<typeof alpha> = "alpha/private/fine-tune";
void known;
void arbitrary;

// An Auth capability is an Effect that needs no service and reads lines through an Effect.
const contract: [
  Types.Equals<ReturnType<AuthCapability["authenticate"]>, Effect.Effect<void, Error>>,
  Types.Equals<AuthenticateOptions["input"], Effect.Effect<string | undefined, Error>>,
] = [true, true];
const capability: AuthCapability = {
  authenticate: ({ input, output }) => Effect.map(input, (line) => output(line ?? "closed")),
};
// @ts-expect-error A capability returns an Effect, not a Promise.
const promised: AuthCapability = { authenticate: async () => {} };
void contract;
void capability;
void promised;

// A Provider declares an API-key variable, a sign-in, or both.
const descriptors: ReadonlyArray<CredentialDescriptor> = [
  "EXAMPLE_KEY",
  { capability: { module: "./auth.js" } },
  { env: "EXAMPLE_KEY", capability: { module: "./auth.js" } },
  { env: "EXAMPLE_KEY", capability: { module: "./auth.js", profile: "work" } },
];
// @ts-expect-error A variable inside an object needs the sign-in beside it.
const variableOnly: CredentialDescriptor = { env: "EXAMPLE_KEY" };
void descriptors;
void variableOnly;
