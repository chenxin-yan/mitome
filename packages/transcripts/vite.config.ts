import { defineConfig } from "vite-plus";
import { libraryTasks, pack, testConfig } from "../../vite.shared.ts";

export default defineConfig({
  ...testConfig,
  pack: {
    ...pack,
    entry: ["src/jsonl.ts"],
    exports: {
      ...pack.exports,
      // A lone entry would be published as the package's root; each adapter is a subpath, so that
      // another can sit beside this one.
      customExports: (exports) => ({ "./jsonl": exports["."] }),
    },
  },
  run: {
    tasks: libraryTasks,
  },
});
