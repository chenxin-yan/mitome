import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { API } from "typescript/unstable/sync";

// Probes the real declarations through the TypeScript API: known Tool names must be offered as
// completions inside `approvals` rule lists, and nothing else (no generated `prefix*` hints).
const prelude = `
import { Schema } from "effect";
import type { Provider } from "@mitome/core";
import { defineAgent, defineExtension } from "../../src/index.js";
declare const model: Provider<"test", readonly []>;
const files = defineExtension({
  name: "files",
  tools: ({ tool }) => [
    tool({ name: "read_file", inputSchema: Schema.Struct({ path: Schema.String }), handler: async ({ path }) => path }),
    tool({ name: "write_file", inputSchema: Schema.Struct({ path: Schema.String }), handler: async ({ path }) => path }),
  ],
});
export { files };
`;
const inlineTools = `tools: ({ tool }) => [tool({ name: "run_shell", inputSchema: Schema.Struct({ command: Schema.String }), handler: async ({ command }) => command })]`;
const cursor = "/*|*/";
const probes = {
  extensionOnly: `defineAgent({ providers: [model], model: "test/default", extensions: [files], approvals: { allow: ["${cursor}"] } });`,
  inlineOnlyAfterTools: `defineAgent({ providers: [model], model: "test/default", ${inlineTools}, approvals: { ask: ["${cursor}"] } });`,
  mixedAfterTools: `defineAgent({ providers: [model], model: "test/default", extensions: [files], ${inlineTools}, approvals: { deny: ["${cursor}"] } });`,
  mixedBeforeTools: `defineAgent({ providers: [model], model: "test/default", extensions: [files], approvals: { deny: ["${cursor}"] }, ${inlineTools} });`,
  extensionCallback: `defineAgent({ providers: [model], model: "test/default", extensions: [files], approvals: (call) => (call.name === "${cursor}" ? "deny" : undefined) });`,
} satisfies Record<string, string>;

const directory = path.join(import.meta.dirname, "approval-completions.virtual");
const tsconfig = path.join(directory, "tsconfig.json");
const fileOf = (probe: string) => path.join(directory, `${probe}.ts`);
const virtualFiles = new Map<string, string>([
  [tsconfig, JSON.stringify({ extends: "../../tsconfig.json", include: ["*.ts"] })],
  ...Object.entries(probes).map(
    ([probe, body]) => [fileOf(probe), prelude + body.replace(cursor, "")] as const,
  ),
]);
// Virtual probe files overlay the real checkout; `undefined` falls back to the real filesystem.
const api = new API({
  cwd: path.join(import.meta.dirname, ".."),
  fs: {
    readFile: (file) => virtualFiles.get(file),
    fileExists: (file) => (virtualFiles.has(file) ? true : undefined),
    directoryExists: (name) => (name === directory ? true : undefined),
    getAccessibleEntries: (name) =>
      name === directory
        ? { files: [...virtualFiles.keys()].map((file) => path.basename(file)), directories: [] }
        : undefined,
  },
});
const snapshot = api.updateSnapshot({ openProjects: [tsconfig] });
const project = snapshot.getProject(tsconfig)!;
afterAll(() => {
  snapshot.dispose();
  api.close();
});

const probe = (name: keyof typeof probes) => {
  const file = fileOf(name);
  const position = prelude.length + probes[name].indexOf(cursor);
  return {
    diagnostics: project.program.getSemanticDiagnostics(file).map((d) => d.text),
    completions:
      project.checker.getCompletionsAtPosition(file, position)?.entries.map((e) => e.name) ?? [],
  };
};

describe("approvals completions", () => {
  test.each([
    ["extensionOnly", ["read_file", "write_file"]],
    ["inlineOnlyAfterTools", ["run_shell"]],
    ["mixedAfterTools", ["read_file", "write_file", "run_shell"]],
    ["mixedBeforeTools", ["read_file", "write_file", "run_shell"]],
  ] as const)("%s rule list offers exactly the known Tool names", (name, expected) => {
    const { diagnostics, completions } = probe(name);
    expect(diagnostics).toEqual([]);
    expect(completions.toSorted()).toEqual([...expected].toSorted());
  });

  test("Extension callback offers the known Tool names for `name`", () => {
    // Unlike rule lists, `name` is the closed known set here, so the empty probe literal is
    // rejected; the completions are what this probe is about.
    const { diagnostics, completions } = probe("extensionCallback");
    expect(diagnostics).toEqual([expect.stringContaining("have no overlap")]);
    expect(completions.toSorted()).toEqual(["read_file", "write_file"]);
  });
});
