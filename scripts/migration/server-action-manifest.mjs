import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = process.cwd();
const sourceRoot = join(root, "apps/web/src");
const manifestPath = join(root, "docs/migration/server-actions.json");

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function isExported(node) {
  return (node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function isAsync(node) {
  return (node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

function isAsyncInitializer(node) {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return isAsync(node);
  return false;
}

const actionFiles = walk(sourceRoot).filter((file) => /\.(?:tsx?|jsx?|mjs|cjs)$/.test(basename(file)));
const actions = [];

for (const file of actionFiles) {
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let hasServerDirective = false;
  for (const statement of tree.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use server") hasServerDirective = true;
  }
  if (!hasServerDirective) continue;

  for (const statement of tree.statements) {
    let name;
    if (ts.isFunctionDeclaration(statement) && isExported(statement) && isAsync(statement) && statement.name) {
      name = statement.name.text;
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && isAsyncInitializer(declaration.initializer)) {
          actions.push({
            name: declaration.name.text,
            source: relative(root, file).split(sep).join("/"),
            line: tree.getLineAndCharacterOfPosition(declaration.getStart(tree)).line + 1,
            owner: "legacy",
            parity: "pending",
          });
        }
      }
      continue;
    }

    if (name) {
      actions.push({
        name,
        source: relative(root, file).split(sep).join("/"),
        line: tree.getLineAndCharacterOfPosition(statement.getStart(tree)).line + 1,
        owner: "legacy",
        parity: "pending",
      });
    }
  }
}

actions.sort((left, right) => left.source.localeCompare(right.source) || left.name.localeCompare(right.name));
if (new Set(actions.map((action) => `${action.source}#${action.name}`)).size !== actions.length) {
  throw new Error("Duplicate exported server action detected");
}

const manifest = `${JSON.stringify({ schemaVersion: 1, actionCount: actions.length, actions }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifest) {
    process.stderr.write("Server action manifest is stale. Run pnpm migration:actions:generate.\n");
    process.exitCode = 1;
  }
} else {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, manifest);
}

process.stdout.write(`Server actions: ${actions.length} exported Next server actions.\n`);
