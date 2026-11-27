import { defineConfig } from "vite-plus";
import { libraryTasks, pack, testConfig } from "../../vite.shared.ts";

export default defineConfig({
  ...testConfig,
  pack: {
    ...pack,
    entry: [
      "src/anthropic/index.ts",
      "src/openai/index.ts",
      "src/openai-compatible/index.ts",
      "src/openai-codex/index.ts",
    ],
  },
  run: {
    tasks: libraryTasks,
  },
});
