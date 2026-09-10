import { RuleTester } from "oxlint/plugins-dev";

import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "runtimeTypeof" };

tester.run("anti-slop/no-runtime-typeof", noRuntimeTypeofRule, {
	valid: ["const value = input;"],
	invalid: [
		{ code: 'const isServer = typeof document === "undefined";', errors: [error] },
		{ code: 'const hasStorage = typeof localStorage !== "undefined";', errors: [error] },
		{
			code: 'if (typeof globalThis.crypto === "undefined") throw new Error("no crypto");',
			errors: [error],
		},
		{ code: 'const missing = "undefined" === typeof process;', errors: [error] },
		{ code: 'if (typeof input === "string") use(input);', errors: [error] },
		{ code: "if (typeof input === undefined) use(input);", errors: [error] },
		{
			code: 'function isString(value: unknown): value is string { return typeof value === "string"; }',
			errors: [error],
		},
		{
			code: 'const isString = (value: unknown): value is string => typeof value === "string";',
			errors: [error],
		},
		{
			code: 'function assertString(value: unknown): asserts value is string { if (typeof value !== "string") throw new Error(); }',
			errors: [error],
		},
	],
});
