import { definePlugin, defineRule } from "@oxlint/plugins";

/**
 * Public packages curate their export surface by name; `export *` leaks everything a module adds
 * later. `export * as Name` is allowed: a namespace module's own export list is its public surface.
 */
export default definePlugin({
  meta: { name: "mitome" },
  rules: {
    "no-export-star": defineRule({
      meta: { messages: { exportStar: "List the exports explicitly instead of `export *`." } },
      create(context) {
        return {
          ExportAllDeclaration(node) {
            if (node.exported !== null) return;
            context.report({ node, messageId: "exportStar" });
          },
        };
      },
    }),
  },
});
