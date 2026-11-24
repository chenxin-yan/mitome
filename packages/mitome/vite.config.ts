import { defineConfig } from "vite-plus";
import { libraryTasks } from "../../vite.shared.ts";

export default defineConfig({
  run: {
    tasks: libraryTasks(),
  },
});
