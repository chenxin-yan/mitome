import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig, lazyPlugins } from "vite-plus";
import { hintsFirst } from "../../vite.shared.ts";

export default defineConfig({
  server: {
    port: 3000,
  },
  // shortcut: vite-plus 1.7.0 types lazyPlugins as `PluginOption[] | undefined`, which
  // exactOptionalPropertyTypes rejects for `plugins` (not yet reported upstream); drop `?? []` once
  // it is typed `PluginOption[]`.
  plugins:
    lazyPlugins(() => [
      // Collections come from `fumadocs-mdx/macro`; source.config.ts only carries MDX options,
      // so the `.source/` index files it would otherwise emit have no reader.
      fumadocsMdx({ index: false }),
      tailwindcss(),
      cloudflare({ viteEnvironment: { name: "ssr" } }),
      tanstackStart({
        prerender: {
          enabled: true,
        },
      }),
      react(),
    ]) ?? [],
  resolve: {
    tsconfigPaths: true,
    alias: {
      tslib: "tslib/tslib.es6.js",
    },
  },
  run: {
    tasks: {
      build: {
        command: "vp build",
        dependsOn: [hintsFirst],
      },
    },
  },
});
