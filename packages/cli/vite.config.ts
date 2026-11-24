import { defineConfig } from "vite-plus";
import { builtInput, hintsFirst, toolchainInput, upstreamBuild } from "../../vite.shared.ts";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/terminal.pty.ts"],
    testTimeout: 15_000,
  },
  run: {
    tasks: {
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
        command: "bun --bun vp test run",
        dependsOn: ["build", upstreamBuild],
        cache: false,
      },
    },
  },
});
