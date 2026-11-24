import { defineConfig } from "vite-plus";
import { hintsFirst, testConfig, upstreamBuild } from "../vite.shared.ts";

export default defineConfig({
  ...testConfig,
  run: {
    tasks: {
      // dev-cli.test.ts runs the source CLI with Bun, whose reads Vite Task cannot see.
      test: {
        command: "vp test run",
        dependsOn: [hintsFirst],
        cache: false,
      },
      // The release fixtures pack, install and run the built packages every time.
      "test:dist": {
        command: "bun release-fixtures.ts",
        dependsOn: [upstreamBuild],
        cache: false,
      },
    },
  },
});
