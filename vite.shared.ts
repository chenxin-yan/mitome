import { transformAsync } from "@babel/core";
import { defaultServerConditions } from "vite-plus";
import type { UserConfig } from "vite-plus";

// Settings the workspace packages' vite.config.ts files share. Vite Task cannot see the files a
// `bun` command reads or writes (vite-task#777) and would replay stale output, so every task that
// runs `bun` lists its cache inputs and outputs or is not cached.

type RunTasks = NonNullable<NonNullable<UserConfig["run"]>["tasks"]>;
type CacheInput = { pattern: string; base: "workspace" };

const workspace = (pattern: string): CacheInput => ({ pattern, base: "workspace" });

/**
 * The private export condition that maps each workspace package's entries to `src`, so the
 * type-checker, the tests and the source CLI see an edit without a build. The published `exports`
 * name only `dist`. The CLI binary and the release tarballs build from `dist`: they are the
 * artifacts.
 */
const sourceCondition = "@mitome/source";

/** Builds the workspace packages this package depends on first. */
export const upstreamBuild = {
  task: "build",
  from: ["dependencies", "devDependencies"],
} satisfies { task: string; from: Array<"dependencies" | "devDependencies"> };

/** The generated model-hint modules exist before anything reads the sources. */
export const hintsFirst = "mitome-monorepo#hints:generate";

/** What every `bun` build reads besides its own package: the pinned toolchain and dependencies. */
export const toolchainInput = [
  workspace("mise.toml"),
  workspace("pnpm-lock.yaml"),
  workspace("packages/config/*.json"),
];

/** The built output of the workspace packages at `directories`, as a dependent reads it. */
export const builtInput = (...directories: Array<string>): Array<CacheInput> =>
  directories.flatMap((directory) => [
    workspace(`${directory}/package.json`),
    workspace(`${directory}/dist/**`),
  ]);

/** Tests resolve the workspace packages from source; those tagged `dist` need built output. */
export const testConfig = {
  ssr: { resolve: { conditions: [sourceCondition, ...defaultServerConditions] } },
  test: {
    tags: [{ name: "dist", description: "Needs built output; runs in the test:dist task" }],
  },
} satisfies UserConfig;

// Rolldown keeps the pure-call annotations already in source but adds none, and Effect's
// tree-shaking needs them on every call that builds a value at module scope.
const annotatePureCalls = {
  name: "annotate-pure-calls",
  async renderChunk(code: string, chunk: { readonly fileName: string }) {
    if (chunk.fileName.endsWith(".d.ts")) {
      return null;
    }
    const result = await transformAsync(code, {
      babelrc: false,
      configFile: false,
      plugins: ["annotate-pure-calls"],
    });
    return result?.code ?? null;
  },
};

/** A library's `vp pack` options; each package adds its `entry`. */
export const pack = {
  unbundle: true,
  dts: true,
  fixedExtension: false,
  // `bin` stays as written: a generated one would point at `src` in the workspace.
  exports: { devExports: sourceCondition, bin: false, packageJson: false },
  publint: true,
  attw: { enabled: true, profile: "esm-only", level: "error" },
  plugins: [annotatePureCalls],
} satisfies UserConfig["pack"];

/** A library's build, its tests from source, and its tests of the built output. */
export const libraryTasks = {
  build: {
    command: "vp pack",
    dependsOn: [hintsFirst],
    // File tracking sees what the build reads, but not the Node version that runs it.
    cache: { input: [{ auto: true }, workspace(".node-version")] },
  },
  test: {
    command: "vp test run --tags-filter=!dist",
    dependsOn: [hintsFirst],
  },
  "test:dist": {
    command: "vp test run --tags-filter=dist",
    dependsOn: ["build", upstreamBuild],
  },
} satisfies RunTasks;
