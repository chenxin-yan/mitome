import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

/** Resolves an identifier reference to its declaring variable by walking enclosing scopes. */
export function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/** Names the alias a bare (argument-free) type reference points at, unwrapping parentheses. */
export function referencedAliasName(type: ESTree.TSType): string | null {
  if (type.type === "TSParenthesizedType") return referencedAliasName(type.typeAnnotation);
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
  return type.typeArguments === null ||
    type.typeArguments === undefined ||
    type.typeArguments.params.length === 0
    ? type.typeName.name
    : null;
}

/** Collects top-level (possibly exported) type alias declarations by name. */
export function collectTypeAliases(
  program: ESTree.Program,
): Map<string, ESTree.TSTypeAliasDeclaration> {
  const aliases = new Map<string, ESTree.TSTypeAliasDeclaration>();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "TSTypeAliasDeclaration") {
      aliases.set(declaration.id.name, declaration);
    }
  }
  return aliases;
}

export type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

/** Finds the type annotation of a parameter, unwrapping property/rest/default patterns. */
export function parameterAnnotation(
  parameter: ESTree.ParamPattern,
): ESTree.TSTypeAnnotation | null | undefined {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

/** Builds a visitor covering every node kind that owns a function signature. */
export function functionSignatureVisitor(handler: (node: ParameterOwner) => void) {
  return {
    ArrowFunctionExpression: handler,
    FunctionDeclaration: handler,
    FunctionExpression: handler,
    TSCallSignatureDeclaration: handler,
    TSConstructSignatureDeclaration: handler,
    TSConstructorType: handler,
    TSDeclareFunction: handler,
    TSEmptyBodyFunctionExpression: handler,
    TSFunctionType: handler,
    TSMethodSignature: handler,
  };
}
