import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = process.cwd();
const appRoot = join(root, "apps/web/src/app");
const manifestPath = join(root, "docs/migration/route-ownership.json");
const overridePath = join(root, "docs/migration/route-ownership-overrides.json");
const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "CONNECT", "TRACE"]);
const methodOrder = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"];

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function hasExportModifier(node) {
  return (node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function exportedMethods(file) {
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Set();
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name) {
      if (methods.has(statement.name.text)) found.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && methods.has(declaration.name.text)) found.add(declaration.name.text);
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            const exportedName = element.propertyName ?? element.name;
            if (ts.isIdentifier(exportedName) && methods.has(exportedName.text)) found.add(exportedName.text);
          }
        }
      }
    }
  }
  return [...found].sort((left, right) => methodOrder.indexOf(left) - methodOrder.indexOf(right));
}

function appRoutePath(directory) {
  const segments = relative(appRoot, directory).split(sep).filter(Boolean);
  return `/${segments.join("/")}`.replace(/^\/$/, "/");
}

function pageRoutePath(file) {
  const directory = relative(appRoot, dirname(file));
  const segments = directory === "." ? [] : directory.split(sep).filter((segment) => !/^\(.+\)$/.test(segment));
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

const routeFiles = walk(appRoot).filter((file) => /^route\.(?:tsx|ts|jsx|js)$/.test(basename(file)));
const pageFiles = walk(appRoot).filter((file) => /^page\.(?:tsx|ts|jsx|js)$/.test(basename(file)));
const entries = [];

for (const file of routeFiles) {
  const path = appRoutePath(dirname(file));
  const source = relative(root, file).split(sep).join("/");
  for (const method of exportedMethods(file)) {
    entries.push({ kind: "api", path, method, source, owner: "legacy", parity: "pending" });
  }
}

for (const file of pageFiles) {
  entries.push({
    kind: "page",
    path: pageRoutePath(file),
    source: relative(root, file).split(sep).join("/"),
    owner: "legacy",
    parity: "pending",
  });
}

if (existsSync(overridePath)) {
  const overrideDocument = JSON.parse(readFileSync(overridePath, "utf8"));
  if (overrideDocument.schemaVersion !== 1 || !Array.isArray(overrideDocument.overrides)) {
    throw new Error("Route ownership overrides must use schemaVersion 1 and an overrides array.");
  }
  const entriesByKey = new Map(entries.map((entry) => [`${entry.kind}:${entry.path}:${entry.method ?? ""}`, entry]));
  const seenOverrides = new Set();

  for (const override of overrideDocument.overrides) {
    const { kind, path, method, owner, parity } = override;
    if (kind !== "api" && kind !== "page") throw new Error(`Invalid route override kind: ${kind}`);
    if (typeof path !== "string" || path.length === 0) throw new Error("Route override path must be a non-empty string.");
    if ((kind === "api" && !methods.has(method)) || (kind === "page" && method !== undefined)) {
      throw new Error(`Invalid method for ${kind} route override: ${method}`);
    }
    const allowedOwners = kind === "api" ? ["legacy", "go", "auth"] : ["legacy", "vite"];
    if (!allowedOwners.includes(owner)) throw new Error(`Invalid owner for ${kind} route ${path}: ${owner}`);
    if (!["pending", "shadow", "verified"].includes(parity)) {
      throw new Error(`Invalid parity state for route ${path}: ${parity}`);
    }
    if (owner !== "legacy" && parity !== "verified") {
      throw new Error(`Route ${path} cannot move to ${owner} before parity is verified.`);
    }

    const key = `${kind}:${path}:${method ?? ""}`;
    if (seenOverrides.has(key)) throw new Error(`Duplicate route ownership override: ${key}`);
    seenOverrides.add(key);
    const entry = entriesByKey.get(key);
    if (!entry) throw new Error(`Stale route ownership override has no source entry: ${key}`);
    entry.owner = owner;
    entry.parity = parity;
  }
}

entries.sort((left, right) => {
  const kind = left.kind.localeCompare(right.kind);
  if (kind !== 0) return kind;
  const path = left.path.localeCompare(right.path);
  if (path !== 0) return path;
  return methodOrder.indexOf(left.method ?? "") - methodOrder.indexOf(right.method ?? "");
});

const manifest = `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!existsSync(manifestPath) || readFileSync(manifestPath, "utf8") !== manifest) {
    process.stderr.write("Route ownership manifest is stale. Run pnpm migration:routes:generate.\n");
    process.exitCode = 1;
  }
} else {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, manifest);
}

process.stdout.write(
  `Routes: ${routeFiles.length} files, ${entries.filter((entry) => entry.kind === "api").length} methods, ${pageFiles.length} pages.\n`,
);
