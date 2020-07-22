import * as recast from "recast";
import * as TypeScriptParser from "recast/parsers/typescript";
import { ASTNode, namedTypes, builders } from "ast-types";
import last from "lodash.last";
import groupBy from "lodash.groupby";
import mapValues from "lodash.mapvalues";
import uniqBy from "lodash.uniqby";

const TS_IGNORE_TEXT = "@ts-ignore";

/**
 * Wraps recast.parse()
 * Sets parser to use the TypeScript parser
 */
export function parse(
  source: string,
  options?: Partial<Omit<recast.Options, "parser">>
): any {
  return recast.parse(source, {
    ...options,
    parser: TypeScriptParser,
  });
}

/**
 * Consolidate import declarations to a valid minimal representation
 * @todo handle multiple local imports
 * @todo handle multiple namespace, default
 * @param declarations import declarations to consolidate
 * @returns consolidated array of import declarations
 */
export function consolidateImports(
  declarations: namedTypes.ImportDeclaration[]
): namedTypes.ImportDeclaration[] {
  const moduleToDeclarations = groupBy(
    declarations,
    (declaration) => declaration.source.value
  );
  const moduleToDeclaration = mapValues(
    moduleToDeclarations,
    (declarations, module) => {
      const specifiers = uniqBy(
        declarations.flatMap((declaration) => declaration.specifiers || []),
        (specifier) => {
          if (specifier.type === "ImportSpecifier") {
            return specifier.imported.name;
          }
          return specifier.type;
        }
      );
      return builders.importDeclaration(
        specifiers,
        builders.stringLiteral(module)
      );
    }
  );
  return Object.values(moduleToDeclaration);
}

/**
 * Get all the import declarations from given file
 * @param ast file AST representation
 * @returns array of import declarations ast nodes
 */
export function getImportDeclarations(
  ast: namedTypes.File
): namedTypes.ImportDeclaration[] {
  return ast.program.body.filter(
    (statement): statement is namedTypes.ImportDeclaration =>
      statement.type === "ImportDeclaration"
  );
}

type ConstantDeclaration = namedTypes.VariableDeclaration & { kind: "const" };

/**
 * Get all the constants defined in the top level of the given file
 * @param ast file AST representation
 * @returns array of constant variable declarations ast nodes
 */
export function getTopLevelConstants(
  ast: namedTypes.File
): namedTypes.VariableDeclarator[] {
  return ast.program.body
    .filter(
      (statement): statement is ConstantDeclaration =>
        statement.type === "VariableDeclaration" && statement.kind === "const"
    )
    .flatMap(
      (declaration) =>
        declaration.declarations as namedTypes.VariableDeclarator[]
    );
}

/**
 * @param code JavaScript module code to get exported names from
 * @returns exported names
 */
export function getExportedNames(
  code: string
): Array<
  namedTypes.Identifier | namedTypes.JSXIdentifier | namedTypes.TSTypeParameter
> {
  const ast = parse(code) as namedTypes.File;
  const ids = [];
  for (const node of ast.program.body) {
    if (node.type === "ExportNamedDeclaration") {
      if (
        node.declaration &&
        "id" in node.declaration &&
        node.declaration.id &&
        "name" in node.declaration.id
      ) {
        ids.push(node.declaration.id);
      }
    }
  }
  return ids;
}

/**
 * Extracts the last statement from a template file
 * @param ast the file AST node
 * @returns the statement AST node
 */
export function getLastStatementFromFile(
  ast: namedTypes.File
): namedTypes.Statement {
  return last(ast.program.body) as namedTypes.Statement;
}

/**
 * Extracts a single class method from a mixin class in a template file
 * Assumes the last statement in the file is a class declaration and the last
 * member in it is the class method
 * @param ast the template file AST representation
 * @returns the class method AST node
 */
export function getMethodFromTemplateAST(
  ast: namedTypes.File
): namedTypes.ClassMethod {
  const mixin = getLastStatementFromFile(ast) as namedTypes.ClassDeclaration;
  const method = last(mixin.body.body);
  return method as namedTypes.ClassMethod;
}

/**
 * Like builders.commentBlock but for doc comments
 * @param value the documentation comment value
 * @param leading whether the comment should be before the node
 * @param trailing whether the comment should be after the node
 */
export function docComment(
  value: string,
  leading: boolean = true,
  trailing: boolean = false
): namedTypes.CommentBlock {
  return builders.commentBlock(`* ${value} `, leading, trailing);
}

/**
 * In given AST replaces identifiers with AST nodes according to given mapping
 * @param ast AST to replace identifiers in
 * @param mapping from identifier to AST node to replace it with
 */
export function interpolateAST(
  ast: ASTNode,
  mapping: { [key: string]: ASTNode }
): void {
  return recast.visit(ast, {
    visitIdentifier(path) {
      const { name } = path.node;
      if (mapping.hasOwnProperty(name)) {
        const replacement = mapping[name];
        path.replace(replacement);
      }
      this.traverse(path);
    },
    // Recast has a bug of traversing class decorators
    // This method fixes it
    visitClassDeclaration(path) {
      const childPath = path.get("decorators");
      if (childPath.value) {
        this.traverse(childPath);
      }
      return this.traverse(path);
    },
    /**
     * Template literals that only hold identifiers mapped to string literals
     * are statically evaluated to string literals.
     * @example
     * ```
     * const ast = parse("`Hello, ${NAME}!`");
     * interpolateAST(ast, { NAME: builders.identifier("World") });
     * print(ast).code === '"Hello, World!"';
     * ```
     */
    visitTemplateLiteral(path) {
      const canTransformToStringLiteral = path.node.expressions.every(
        (expression) =>
          expression.type === "Identifier" &&
          expression.name in mapping &&
          mapping[expression.name].type === "StringLiteral"
      );
      if (canTransformToStringLiteral) {
        path.node.expressions = path.node.expressions.map((expression) => {
          const identifier = expression as namedTypes.Identifier;
          return mapping[identifier.name] as namedTypes.StringLiteral;
        });
        path.replace(transformTemplateLiteralToStringLiteral(path.node));
      }
      this.traverse(path);
    },
  });
}

export function transformTemplateLiteralToStringLiteral(
  templateLiteral: namedTypes.TemplateLiteral
): namedTypes.StringLiteral {
  const value = templateLiteral.quasis
    .map((quasie, i) => {
      const expression = templateLiteral.expressions[
        i
      ] as namedTypes.StringLiteral;
      if (expression) {
        return quasie.value.raw + expression.value;
      }
      return quasie.value.raw;
    })
    .join("");
  return builders.stringLiteral(value);
}

/**
 * Removes all TypeScript ignore comments
 * @param ast the AST to remove the comments from
 */
export function removeTSIgnoreComments(ast: ASTNode) {
  recast.visit(ast, {
    visitComment(path) {
      if (path.value.value.includes(TS_IGNORE_TEXT)) {
        path.prune();
      }
      this.traverse(path);
    },
  });
}

/**
 * Removes all TypeScript variable declares
 * @param ast the AST to remove the declares from
 */
export function removeTSVariableDeclares(ast: ASTNode): void {
  recast.visit(ast, {
    visitVariableDeclaration(path) {
      if (path.get("declare").value) {
        path.prune();
      }
      this.traverse(path);
    },
  });
}
