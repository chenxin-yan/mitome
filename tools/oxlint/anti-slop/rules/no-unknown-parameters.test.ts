import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters", noUnknownParametersRule, {
	valid: [
		"function enrich(cause: unknown): void {}",
		"function enrich(cause: Error | unknown): void {}",
		"function parse(value: string | number): void {}",
	],
	invalid: [
		{ code: "function parse(value: unknown): void {}", errors: [error] },
		{ code: "function parse(value: string | unknown): void {}", errors: [error] },
		{
			code: "function parse(value: string | (number | unknown)): void {}",
			errors: [error],
		},
		{
			code: "function isString(value: unknown): value is string { return true; }",
			errors: [error],
		},
		{
			code: "const isString = (value: unknown): value is string => true;",
			errors: [error],
		},
		{
			code: "function assertString(value: unknown): asserts value is string {}",
			errors: [error],
		},
		{ code: "type Guard = (value: unknown) => value is string;", errors: [error] },
		{
			code: "declare function isString(value: unknown): value is string;",
			errors: [error],
		},
		{
			code: "type Guards = { isString(value: unknown): value is string };",
			errors: [error],
		},
		{
			code: "function isString(value: unknown, context: unknown): value is string { return true; }",
			errors: [error, error],
		},
		{
			code: "export function parse({ value }: unknown = {}): void {}",
			errors: [{ ...error, data: { parameter: "{ value }" } }],
		},
	],
});
