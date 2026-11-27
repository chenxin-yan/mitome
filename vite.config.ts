import { fileURLToPath } from "node:url";
import cloudflare from "@cloudflare/oxlint-config/vite-plus";
import { defineConfig } from "vite-plus";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
// A later override replaces an earlier one's options for the same rule, so each repeats this.
const rootOmitsSubpaths = {
  regex: String.raw`(^|/)(kernel|terminal)(\.[jt]s)?$`,
  message: "The root entry never imports a subpath such as kernel or terminal (ADR-0061).",
};
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
      // packages type-check against each other's sources, so nothing needs building first.
      check: {
        command: "effect-tsgo vp check",
        dependsOn: ["hints:generate"],
      },
      // Every package's tests from source (`test:task`) and of built output (`test:dist:task`), each
      // after only the builds it needs: `vp run -r test` would also hold each package's tests until those of the
      // packages it depends on had passed. The `test` and `test:dist` scripts run them, as a name
      // cannot be both a package.json script and a task.
      "test:task": {
        command: [],
        dependsOn: [
          "@mitome/core#test",
          "@mitome/providers#test",
          "@mitome/transcripts#test",
          "create-mitome#test",
          "@mitome/cli#test",
          "@mitome/scripts#test",
        ],
      },
      "test:dist:task": {
        command: [],
        dependsOn: [
          "@mitome/core#test:dist",
          "@mitome/providers#test:dist",
          "@mitome/transcripts#test:dist",
          "create-mitome#test:dist",
          "@mitome/cli#test:dist",
          "@mitome/scripts#test:dist",
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
    extends: [cloudflare],
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
      // @effect/vitest's test functions are test blocks too.
      "vitest/no-standalone-expect": [
        "error",
        {
          additionalTestBlockFunctions: [
            "it.effect",
            "it.live",
            "it.effect.skipIf",
            "it.live.skipIf",
          ],
        },
      ],
      // A promise's catch callback takes `unknown`, which anti-slop/no-unknown-parameters allows
      // only under the name `cause`.
      "unicorn/catch-error-name": ["error", { ignore: ["^cause$"] }],
      "typescript/no-unnecessary-condition": [
        "error",
        {
          allowConstantLoopConditions: "only-allowed-literals",
        },
      ],
      "typescript/restrict-plus-operands": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",
      "anti-slop-effect/prefer-effect-match": "error",
      "mitome/no-schema-unknown-type": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
      // Turned off on adopting @cloudflare/oxlint-config; each is evaluated in a commit of its own.
      "import/no-namespace": "off",
      "jsx-a11y/html-has-lang": "off",
      "typescript/no-empty-object-type": "off",
      "typescript/no-explicit-any": "off",
      "typescript/no-non-null-assertion": "off",
      "typescript/no-unsafe-argument": "off",
      "typescript/no-unsafe-assignment": "off",
      "typescript/no-unsafe-call": "off",
      "typescript/no-unsafe-function-type": "off",
      "typescript/no-unsafe-member-access": "off",
      "typescript/no-unsafe-return": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/only-throw-error": "off",
      "unicorn/consistent-function-scoping": "off",
      "vitest/expect-expect": "off",
      "vitest/no-conditional-expect": "off",
      "vitest/require-mock-type-parameters": "off",
      "vitest/require-to-throw-message": "off",
      "vitest/valid-expect": "off",
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
        files: ["packages/mitome/src/**"],
        rules: {
          "eslint/no-restricted-imports": ["error", { patterns: [rootOmitsSubpaths] }],
        },
      },
      {
        files: ["packages/mitome/src/session/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                rootOmitsSubpaths,
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
        files: ["packages/providers/src/**", "packages/transcripts/src/**", "packages/cli/src/**"],
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
        // The files that bind the Providers' and the Transcripts' services to Node (ADR-0065).
        files: [
          "packages/providers/src/shared/platform.ts",
          "packages/transcripts/src/platform.ts",
        ],
        rules: {
          "eslint/no-restricted-imports": "off",
        },
      },
      {
        // Programs that print to a person by design: the scaffold launcher, the CLI's launcher and
        // release build, and the repository scripts.
        files: ["packages/create-mitome/src/index.ts", "packages/cli/scripts/**", "scripts/**"],
        rules: {
          "no-console": "off",
        },
      },
      {
        files: ["**/test/**", "**/*.test.*"],
        rules: {
          "anti-slop-effect/no-manual-tagged-construction": "off",
        },
      },
      {
        // React code lives only in the docs app; elsewhere a callback named `use` is not a hook.
        files: ["packages/**", "scripts/**", "dev/**"],
        rules: {
          "react/rules-of-hooks": "off",
        },
      },
      {
        files: ["apps/docs/**"],
        plugins: ["react"],
        rules: {
          // TanStack Router's notFound() and redirect() are thrown by design and are not Errors.
          "typescript/only-throw-error": [
            "error",
            {
              allow: [
                {
                  from: "package",
                  package: "@tanstack/router-core",
                  name: ["NotFoundError", "Redirect"],
                },
              ],
            },
          ],
        },
        env: {
          browser: true,
        },
      },
    ],
    env: {
      ...cloudflare.env,
      builtin: true,
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: [
      ...cloudflare.ignorePatterns,
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
