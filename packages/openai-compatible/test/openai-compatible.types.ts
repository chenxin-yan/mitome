import { env, openaiCompatible } from "../src/index.js";

// @ts-expect-error A compatible endpoint must be selected explicitly.
openaiCompatible("provider-model", env("PROVIDER_API_KEY"));
