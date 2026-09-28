import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const apiDir = join(root, "apps/api");
const specPath = join(root, "contracts/openapi/go-internal-v1.yaml");
const tsOutputPath = join(root, "apps/web/src/generated/go-internal-v1.ts");
const goOutputPath = join(apiDir, "internal/apicontract/go_internal_v1.gen.go");
const configPath = join(apiDir, "oapi-codegen-policy.yaml");
const checkOnly = process.argv.includes("--check");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with status ${result.status}`);
}

function generateTypeScript(outputPath) {
  run(
    "pnpm",
    ["exec", "openapi-typescript", specPath, "--output", outputPath],
    root,
  );
}

function generateGo(configOutput) {
  const config = readFileSync(configPath, "utf8");
  const outputLine = "output: internal/apicontract/go_internal_v1.gen.go";
  if (!config.includes(outputLine))
    throw new Error(
      "Go contract generator output setting changed unexpectedly",
    );
  const temporaryConfig = join(
    dirname(configPath),
    `.oapi-codegen-${process.pid}.yaml`,
  );
  writeFileSync(
    temporaryConfig,
    config.replace(outputLine, `output: ${JSON.stringify(configOutput)}`),
  );
  try {
    run(
      "go",
      [
        "tool",
        "oapi-codegen",
        "-config",
        temporaryConfig,
        "../../contracts/openapi/go-internal-v1.yaml",
      ],
      apiDir,
    );
  } finally {
    rmSync(temporaryConfig, { force: true });
  }
}

const temporaryDir = mkdtempSync(join(tmpdir(), "chaste-api-contracts-"));
const temporaryTS = join(temporaryDir, "go-internal-v1.ts");
const temporaryGo = join(temporaryDir, "go_internal_v1.gen.go");

try {
  mkdirSync(dirname(tsOutputPath), { recursive: true });
  mkdirSync(dirname(goOutputPath), { recursive: true });
  generateTypeScript(checkOnly ? temporaryTS : tsOutputPath);
  generateGo(checkOnly ? temporaryGo : goOutputPath);

  if (checkOnly) {
    const outputs = [
      ["TypeScript", tsOutputPath, temporaryTS],
      ["Go", goOutputPath, temporaryGo],
    ];
    const stale = outputs.filter(([, committedPath, generatedPath]) => {
      try {
        return (
          readFileSync(committedPath, "utf8") !==
          readFileSync(generatedPath, "utf8")
        );
      } catch {
        return true;
      }
    });
    if (stale.length > 0) {
      process.stderr.write(
        `Generated API contract output is stale: ${stale.map(([language]) => language).join(", ")}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write("Contract outputs current\n");
    }
  } else {
    process.stdout.write("Generated TypeScript and Go API contract models\n");
  }
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
