import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import process from "node:process";

const root = process.cwd();
const inventoryPaths = [
  "docs/migration/continuity-inventory.md",
  "docs/migration/integrations.md",
  "docs/migration/workers-events.md",
];
const censusPath = resolve(root, "docs/migration/retired-source-census.json");
const freezeCensus = process.argv.includes("--freeze-census");
const citationPattern = /(?<![A-Za-z0-9_.-])((?:\.\.\/|\.\/)*[-A-Za-z0-9_@.()[\]]+(?:\/[-A-Za-z0-9_@.()[\]]+)*\.(?:tsx?|jsx?|mjs|cjs|go|sql|md|json|ya?ml))(?::|#L)(\d+)(?:-(?:L)?(\d+))?((?:,\d+(?:-\d+)?)*)/g;
const errors = [];
let citationCount = 0;
const frozenSources = new Map();
const census = freezeCensus || !existsSync(censusPath) ? null : JSON.parse(readFileSync(censusPath, "utf8"));

function repoRelative(sourcePath) {
  return relative(root, sourcePath).split(sep).join("/");
}

function sourceReferencePath(inventoryFile, sourceReference) {
  return sourceReference.startsWith("../") || sourceReference.startsWith("./")
    ? resolve(dirname(inventoryFile), sourceReference)
    : resolve(root, sourceReference);
}

function gitHeadLineCount(path) {
  try {
    return execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").length;
  } catch {
    return null;
  }
}

for (const inventoryPath of inventoryPaths) {
  const inventoryFile = resolve(root, inventoryPath);
  if (!existsSync(inventoryFile)) {
    errors.push(`${inventoryPath}: inventory file is missing`);
    continue;
  }

  const content = readFileSync(inventoryFile, "utf8");
  const linkedTargets = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, _label, target) => target);
  let fileCitationCount = 0;
  for (const match of linkedTargets.matchAll(citationPattern)) {
    const sourceReference = match[1];
    const sourcePath = sourceReferencePath(inventoryFile, sourceReference);
    const inventoryLine = linkedTargets.slice(0, match.index).split("\n").length;
    let sourceLineCount;
    if (existsSync(sourcePath)) {
      sourceLineCount = readFileSync(sourcePath, "utf8").split("\n").length;
      const relativePath = repoRelative(sourcePath);
      if (freezeCensus && relativePath.startsWith("apps/web/")) {
        frozenSources.set(relativePath, sourceLineCount);
      }
    } else {
      const relativePath = repoRelative(sourcePath);
      const frozen = census?.sources?.[relativePath];
      if (typeof frozen === "number") {
        sourceLineCount = frozen;
      } else if (freezeCensus) {
        const headLines = gitHeadLineCount(relativePath);
        if (headLines === null) {
          errors.push(`${inventoryPath}:${inventoryLine}: cited source does not exist and is absent from git HEAD: ${sourceReference}`);
          continue;
        }
        sourceLineCount = headLines;
        frozenSources.set(relativePath, headLines);
      } else {
        errors.push(`${inventoryPath}:${inventoryLine}: cited source does not exist: ${sourceReference}`);
        continue;
      }
    }

    const ranges = [[Number(match[2]), Number(match[3] ?? match[2])]];
    for (const extraRange of match[4].matchAll(/,(\d+)(?:-(\d+))?/g)) {
      ranges.push([Number(extraRange[1]), Number(extraRange[2] ?? extraRange[1])]);
    }

    for (const [start, end] of ranges) {
      fileCitationCount += 1;
      citationCount += 1;
      if (start < 1 || end < start || end > sourceLineCount) {
        errors.push(
          `${inventoryPath}:${inventoryLine}: citation ${sourceReference}:${start}-${end} is outside the source's ${sourceLineCount} lines`,
        );
      }
    }
  }

  if (fileCitationCount === 0) errors.push(`${inventoryPath}: no source line citations found`);
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else if (freezeCensus) {
  writeFileSync(
    censusPath,
    `${JSON.stringify(
      { schemaVersion: 1, sources: Object.fromEntries([...frozenSources].sort(([left], [right]) => left.localeCompare(right))) },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`Frozen source census: ${frozenSources.size} retired source files.\n`);
} else {
  process.stdout.write(`Continuity inventory: ${inventoryPaths.length} docs, ${citationCount} valid source line citations.\n`);
}
