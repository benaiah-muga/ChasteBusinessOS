import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const inventoryPaths = [
  "docs/migration/continuity-inventory.md",
  "docs/migration/integrations.md",
  "docs/migration/workers-events.md",
];
const citationPattern = /(?<![A-Za-z0-9_.-])((?:\.\.\/|\.\/)*[-A-Za-z0-9_@.()[\]]+(?:\/[-A-Za-z0-9_@.()[\]]+)*\.(?:tsx?|jsx?|mjs|cjs|go|sql|md|json|ya?ml))(?::|#L)(\d+)(?:-(?:L)?(\d+))?((?:,\d+(?:-\d+)?)*)/g;
const errors = [];
let citationCount = 0;

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
    const sourcePath = sourceReference.startsWith("../") || sourceReference.startsWith("./")
      ? resolve(dirname(inventoryFile), sourceReference)
      : resolve(root, sourceReference);
    const inventoryLine = linkedTargets.slice(0, match.index).split("\n").length;
    if (!existsSync(sourcePath)) {
      errors.push(`${inventoryPath}:${inventoryLine}: cited source does not exist: ${sourceReference}`);
      continue;
    }

    const sourceLines = readFileSync(sourcePath, "utf8").split("\n");
    const ranges = [[Number(match[2]), Number(match[3] ?? match[2])]];
    for (const extraRange of match[4].matchAll(/,(\d+)(?:-(\d+))?/g)) {
      ranges.push([Number(extraRange[1]), Number(extraRange[2] ?? extraRange[1])]);
    }

    for (const [start, end] of ranges) {
      fileCitationCount += 1;
      citationCount += 1;
      if (start < 1 || end < start || end > sourceLines.length) {
        errors.push(
          `${inventoryPath}:${inventoryLine}: citation ${sourceReference}:${start}-${end} is outside the source's ${sourceLines.length} lines`,
        );
      }
    }
  }

  if (fileCitationCount === 0) errors.push(`${inventoryPath}: no source line citations found`);
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Continuity inventory: ${inventoryPaths.length} docs, ${citationCount} valid source line citations.\n`);
}
