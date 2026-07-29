# Register Providers and select Models by Qualified Model id

To support Host model selection, an Agent Definition registers an unordered array of configured Providers, names one Default Model with a Qualified Model id written as `provider/model`, and keeps its ordered Plugin array in the same plain `defineAgent` object. A Provider exposes only its stable id and Mitome-supported `modelIds`; credential descriptors and Effect AI Model provisioning remain opaque, model hints do not restrict future or private ids beneath a registered Provider, and duplicate Provider ids reject the Definition. Default Model validation rejects an unregistered Provider before Session startup; a Host override does so before its Turn starts. Qualified Model ids split at the first `/`, leaving any later `/` characters in the Provider-native Model id.

This amends ADR-0013's single-Model authentication selection and carries forward ADR-0028's open model-hint semantics. Retaining both pre-provisioned Model values and Qualified Model ids would duplicate Provider configuration and prevent one Session from selecting different Models between Turns.

## Consequences

- `model` is the Default Model; a Host may override it for one Turn, and every Step in that Turn uses the same selection.
- Selected Models are provisioned lazily, cached within the Session, and released with it; Provider order does not imply display precedence, routing, or fallback.
- Official Providers own their conventional Credential defaults. OpenAI accepts an `apiKeyEnv` override instead of requiring an `env()` helper in ordinary Agent Definitions.
- Existing package-level `knownModelIds` exports remain the generated source for built-in Provider `modelIds`; the two names distinguish the package export from the Provider value's field.
- `makeProvider` is an advanced Effect-native interface for Provider authors: it accepts a Provider id, Model hints, a declarative Credential descriptor, and a native-id-to-LanguageModel-Layer function.
- `mitome auth login` and `mitome auth logout` auto-select one registered Provider or present a single-select picker when several are available.
- The Agent Definition remains one generic-preserving plain object. Plugins remain ordered because their Instructions and Hooks compose; Providers are alternatives and therefore have no ordering semantics.

A global Provider registry, pre-provisioned Model values alongside Providers, a second positional Plugin argument, automatic Provider fallback, custom catalog metadata, and a parallel Promise-based Provider transport interface were rejected as additional sources of truth or behavior not required by the selection use case.
