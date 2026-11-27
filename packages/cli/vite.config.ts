import { defineConfig } from "vite-plus";
import {
  builtInput,
  hintsFirst,
  testConfig,
  toolchainInput,
  upstreamBuild,
} from "../../vite.shared.ts";

export default defineConfig({
  ...testConfig,
  test: {
    ...testConfig.test,
    include: ["test/**/*.test.ts", "test/terminal.pty.ts"],
    testTimeout: 15_000,
  },
  run: {
    tasks: {
      // The binary is an artifact: it bundles the built packages, not their sources.
      build: {
        command:
          "bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --compile-autoload-package-json src/index.ts --outfile dist/local/mitome",
        dependsOn: [upstreamBuild, hintsFirst],
        cache: {
          input: [
            "src/**",
            "package.json",
            "tsconfig.json",
            ...toolchainInput,
            ...builtInput("packages/mitome", "packages/providers", "packages/create-mitome"),
          ],
          output: ["dist/local/**"],
        },
      },
      // The terminal needs the Bun runtime (OpenTUI), so the whole package's tests run on it.
      test: {
        command: "bun --bun vp test run --tags-filter=!dist",
        dependsOn: [hintsFirst],
        cache: false,
      },
      "test:dist": {
        command: "bun --bun vp test run --tags-filter=dist",
        dependsOn: ["build", upstreamBuild],
        cache: false,
      },
    },
  },
});
