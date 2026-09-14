import { defineConfig } from "fumadocs-mdx/config";
import { createGenerator, remarkAutoTypeTable } from "fumadocs-typescript";

// Collections are declared with `fumadocs-mdx/macro` in src/lib/source.ts; this file only
// carries global MDX options. The type-table generator drives the TypeScript compiler, so it
// stays out of modules that are also bundled for the browser.
//
// No persistent cache: its key hashes only the file named in `path`, and the reference pages
// point at barrel entry files, so an edit to a re-exported type would serve a stale table.
const generator = createGenerator();

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [[remarkAutoTypeTable, { generator }]],
  },
});
