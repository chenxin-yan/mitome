import { definePlugin, defineRule, type ESTree, type SourceCode } from "vite-plus/lint/plugins";
import { resolveVariable } from "./anti-slop/shared/scope.ts";

/** Whether `specifier` of an import from `source` names Effect's `Schema` module, or its `Unknown`. */
function importsSchema(
  source: string,
  specifier: ESTree.Node,
  imported: "Schema" | "Unknown",
): boolean {
  if (specifier.type !== "ImportSpecifier") {
    return imported === "Schema" && source === "effect/Schema";
  }
  const name =
    specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
  return name === imported && source === (imported === "Schema" ? "effect" : "effect/Schema");
}

/** Whether `identifier` resolves, where it is used, to an import of Effect's `Schema` or `Unknown`. */
function resolvesToImport(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
  imported: "Schema" | "Unknown",
): boolean {
  return (
    resolveVariable(sourceCode, identifier)?.defs.some(
      (definition) =>
        definition.type === "ImportBinding" &&
        definition.parent?.type === "ImportDeclaration" &&
        importsSchema(definition.parent.source.value, definition.node, imported),
    ) ?? false
  );
}

/** Whether `node` is `typeof <schema>.Unknown.Type` or `typeof <unknown>.Type` on Effect's own. */
function isSchemaUnknownType(sourceCode: SourceCode, node: ESTree.TSTypeQuery): boolean {
  const name = node.exprName;
  if (name.type !== "TSQualifiedName" || name.right.name !== "Type") {
    return false;
  }
  const query = name.left;
  if (query.type === "Identifier") {
    return resolvesToImport(sourceCode, query, "Unknown");
  }
  return (
    query.type === "TSQualifiedName" &&
    query.right.name === "Unknown" &&
    query.left.type === "Identifier" &&
    resolvesToImport(sourceCode, query.left, "Schema")
  );
}

export default definePlugin({
  meta: { name: "mitome" },
  rules: {
    /**
     * Public packages curate their export surface by name; `export *` leaks everything a module adds
     * later. `export * as Name` is allowed: a namespace module's own export list is its public surface.
     */
    "no-export-star": defineRule({
      meta: { messages: { exportStar: "List the exports explicitly instead of `export *`." } },
      create(context) {
        return {
          ExportAllDeclaration(node) {
            if (node.exported !== null) {
              return;
            }
            context.report({ node, messageId: "exportStar" });
          },
        };
      },
    }),
    /** `typeof Schema.Unknown.Type` is `unknown` spelled another way, which hides it from review. */
    "no-schema-unknown-type": defineRule({
      meta: {
        messages: {
          synonym:
            "Write `unknown`, or the type the value has, instead of `typeof Schema.Unknown.Type`.",
        },
      },
      create(context) {
        return {
          TSTypeQuery(node) {
            if (isSchemaUnknownType(context.sourceCode, node)) {
              context.report({ node, messageId: "synonym" });
            }
          },
        };
      },
    }),
  },
});
