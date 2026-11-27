import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const docsOutput = [
  "apps/docs/.output/",
  "apps/docs/.tanstack/",
  "apps/docs/.nitro/",
  "apps/docs/.vercel/",
  "apps/docs/src/routeTree.gen.ts",
];

export default defineConfig({
  run: {
    tasks: {
      // The one static gate: format, lint and type-check, with Effect's diagnostics from the
      // Effect-patched linter and checker that effect-tsgo runs in place of the stock ones. The
      // packages type-check against each other's built declarations.
      check: {
        command: "effect-tsgo vp check",
        dependsOn: [
          "hints:generate",
          "@mitome/core#build",
          "@mitome/providers#build",
          "create-mitome#build",
        ],
      },
      // Every package's tests, each after only the builds it needs: `vp run -r test` would also hold
      // each package's tests until those of the packages it depends on had passed. The `test` script
      // runs it, as a name cannot be both a package.json script and a task.
      "test:task": {
        command: [],
        dependsOn: [
          "@mitome/core#test",
          "@mitome/providers#test",
          "create-mitome#test",
          "@mitome/cli#test",
          "@mitome/scripts#test",
        ],
      },
      "hints:generate": {
        command: "bun scripts/generate-model-hints.ts",
        // Bun's reads and writes are invisible to Vite Task (vite-task#777).
        cache: {
          input: [
            "scripts/generate-model-hints.ts",
            "scripts/models-dev.ts",
            "scripts/models-dev.snapshot.json",
            "packages/providers/src/openai-codex/models.ts",
            "packages/providers/src/anthropic/models.ts",
            "packages/create-mitome/package.json",
            "pnpm-lock.yaml",
            "mise.toml",
          ],
          output: [
            "packages/providers/src/openai/models.ts",
            "packages/create-mitome/src/model-hints.ts",
          ],
        },
      },
    },
  },
  staged: {
    "*": "effect-tsgo vp check --fix",
  },
  fmt: {
    ignorePatterns: ["tools/oxlint/anti-slop/", ...docsOutput],
  },
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "eslint", "promise", "import", "jsdoc"],
    jsPlugins: [
      { name: "anti-slop", specifier: local("./tools/oxlint/anti-slop/index.ts") },
      { name: "anti-slop-effect", specifier: local("./tools/oxlint/anti-slop/effect/index.ts") },
      { name: "mitome", specifier: local("./tools/oxlint/mitome.ts") },
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
    ],
    categories: {
      correctness: "error",
    },
    rules: {
      "typescript/no-misused-promises": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "typescript/return-await": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "typescript/no-unnecessary-condition": [
        "error",
        {
          allowConstantLoopConditions: "only-allowed-literals",
        },
      ],
      "typescript/restrict-plus-operands": "error",
      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",
      "anti-slop-effect/prefer-effect-match": "error",
      "mitome/no-schema-unknown-type": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    // Overrides cannot hold settings.
    settings: {
      react: {
        version: "19.3.1",
      },
    },
    overrides: [
      {
        files: ["packages/*/src/**"],
        rules: {
          "mitome/no-export-star": "error",
          "eslint/no-restricted-properties": [
            "error",
            {
              object: "JSON",
              property: "parse",
              message:
                "Decode JSON with a named `Schema.fromJsonString` schema, so its form is checked where it is read.",
            },
          ],
        },
      },
      {
        files: ["packages/mitome/src/session/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  regex: "(^|/)agent/",
                  message: "session/ runs a conversation and never imports agent/ (ADR-0061).",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["packages/providers/src/**", "packages/cli/src/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  regex: "^(node:)?(child_process|fs|http|https|net|os|path|readline|url)(/|$)",
                  message:
                    "Reach the platform through Effect's services (FileSystem, Path, ChildProcessSpawner, Stdio); see ADR-0065.",
                },
              ],
            },
          ],
        },
      },
      {
        // The one file that binds the Providers' services to Node (ADR-0065).
        files: ["packages/providers/src/shared/platform.ts"],
        rules: {
          "eslint/no-restricted-imports": "off",
        },
      },
      {
        files: ["**/test/**", "**/*.test.*"],
        rules: {
          "anti-slop-effect/no-manual-tagged-construction": "off",
        },
      },
      {
        files: ["apps/docs/**"],
        plugins: ["react"],
        env: {
          browser: true,
        },
      },
    ],
    env: {
      builtin: true,
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: [
      "**/node_modules/",
      "**/dist/",
      ".agents/",
      ".pi/**",
      ".claude/**",
      ".pi-subagents/**",
      ".agent-sources/**",
      "tools/oxlint/anti-slop/**",
      ...docsOutput,
    ],
  },
});
