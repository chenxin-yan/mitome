import { defineConfig } from "vite-plus";
import { libraryTasks, pack, testConfig } from "../../vite.shared.ts";

export default defineConfig({
  ...testConfig,
  pack: {
    ...pack,
    entry: ["src/index.ts", "src/template.ts"],
    exports: {
      ...pack.exports,
      // `src/index.ts` is the `create-mitome` command, which runs when imported.
      customExports: (exports) => {
        delete exports["."];
        return exports;
      },
    },
  },
  run: {
    tasks: libraryTasks,
  },
});
