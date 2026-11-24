import { defineConfig } from "vite-plus";
import { libraryTasks, pack, testConfig } from "../../vite.shared.ts";

export default defineConfig({
  ...testConfig,
  pack: {
    ...pack,
    entry: ["src/index.ts", "src/kernel.ts"],
    // Consumers may read the manifest as `@mitome/core/package.json`.
    exports: { ...pack.exports, packageJson: true },
  },
  run: {
    tasks: libraryTasks,
  },
});
