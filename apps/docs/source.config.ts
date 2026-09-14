import { defineConfig } from "fumadocs-mdx/config";
import {
  createFileSystemGeneratorCache,
  createGenerator,
  remarkAutoTypeTable,
} from "fumadocs-typescript";

// Collections are declared with `fumadocs-mdx/macro` in src/lib/source.ts; this file only
// carries global MDX options. The type-table generator drives the TypeScript compiler, so it
// stays out of modules that are also bundled for the browser.
const generator = createGenerator({
  cache: createFileSystemGeneratorCache(".fumadocs-typescript"),
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [[remarkAutoTypeTable, { generator }]],
  },
});
