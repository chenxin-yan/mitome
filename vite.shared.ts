import type { UserConfig } from "vite-plus";

// Task objects the workspace packages' vite.config.ts files share. Vite Task cannot see the files a
// `bun` command reads or writes (vite-task#777) and would replay stale output, so every task that
// runs `bun` lists its cache inputs and outputs or is not cached.

type RunTasks = NonNullable<NonNullable<UserConfig["run"]>["tasks"]>;
type CacheInput = { pattern: string; base: "workspace" };

const workspace = (pattern: string): CacheInput => ({ pattern, base: "workspace" });

/** Builds the workspace packages this package depends on first. */
export const upstreamBuild = {
  task: "build",
  from: ["dependencies", "devDependencies"],
} satisfies { task: string; from: Array<"dependencies" | "devDependencies"> };

/** The generated model-hint modules exist before anything builds. */
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

/** A library's build (`tsc` and the pure-call annotations) and its tests, which also import `dist`. */
export const libraryTasks = (...upstream: Array<string>) =>
  ({
    build: {
      command: "bun ../../scripts/build-lib.ts",
      dependsOn: [upstreamBuild, hintsFirst],
      cache: {
        input: [
          "src/**",
          "package.json",
          "tsconfig.json",
          "tsconfig.build.json",
          workspace("scripts/build-lib.ts"),
          ...toolchainInput,
          ...builtInput(...upstream),
        ],
        output: ["dist/**"],
      },
    },
    test: {
      command: "vp test run",
      dependsOn: ["build", upstreamBuild],
    },
  }) satisfies RunTasks;
