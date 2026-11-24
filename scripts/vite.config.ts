import { defineConfig } from "vite-plus";
import { upstreamBuild } from "../vite.shared.ts";

export default defineConfig({
  run: {
    tasks: {
      // The release fixtures pack, install and run the built packages every time.
      test: {
        command: "vp test run && bun release-fixtures.ts",
        dependsOn: [upstreamBuild],
        cache: false,
      },
    },
  },
});
