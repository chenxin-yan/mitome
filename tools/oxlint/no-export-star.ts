import { definePlugin, defineRule } from "@oxlint/plugins";

/** Public packages curate their export surface by name; `export *` leaks everything a module adds later. */
export default definePlugin({
  meta: { name: "mitome" },
  rules: {
    "no-export-star": defineRule({
      meta: { messages: { exportStar: "List the exports explicitly instead of `export *`." } },
      create(context) {
        return {
          ExportAllDeclaration(node) {
            context.report({ node, messageId: "exportStar" });
          },
        };
      },
    }),
  },
});
