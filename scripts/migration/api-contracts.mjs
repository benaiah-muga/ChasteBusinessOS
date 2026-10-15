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
const checkOnly = process.argv.includes("--check");

const contracts = [
  {
    name: "internal",
    specPath: join(root, "contracts/openapi/go-internal-v1.yaml"),
    tsOutputPath: join(root, "apps/web/src/generated/go-internal-v1.ts"),
    goOutputPath: join(apiDir, "internal/apicontract/go_internal_v1.gen.go"),
    configPath: join(apiDir, "oapi-codegen-policy.yaml"),
    goInputPath: "../../contracts/openapi/go-internal-v1.yaml",
    outputLine: "output: internal/apicontract/go_internal_v1.gen.go",
    temporaryTS: "go-internal-v1.ts",
    temporaryGo: "go_internal_v1.gen.go",
  },
  {
    name: "business",
    specPath: join(root, "contracts/openapi/business-v1.yaml"),
    tsOutputPath: join(root, "apps/web-vite/src/generated/business-v1.ts"),
    goOutputPath: join(
      apiDir,
      "internal/apicontract/business/business_v1.gen.go",
    ),
    configPath: join(apiDir, "oapi-codegen-business.yaml"),
    goInputPath: "../../contracts/openapi/business-v1.yaml",
    outputLine: "output: internal/apicontract/business/business_v1.gen.go",
    temporaryTS: "business-v1.ts",
    temporaryGo: "business_v1.gen.go",
  },
];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with status ${result.status}`);
}

function generateTypeScript(contract, outputPath) {
  run(
    "pnpm",
    ["exec", "openapi-typescript", contract.specPath, "--output", outputPath],
    root,
  );
}

function generateGo(contract, configOutput) {
  const config = readFileSync(contract.configPath, "utf8");
  if (!config.includes(contract.outputLine))
    throw new Error(
      "Go contract generator output setting changed unexpectedly",
    );
  const temporaryConfig = join(
    dirname(contract.configPath),
    `.oapi-codegen-${contract.name}-${process.pid}.yaml`,
  );
  writeFileSync(
    temporaryConfig,
    config.replace(
      contract.outputLine,
      `output: ${JSON.stringify(configOutput)}`,
    ),
  );
  try {
    run(
      "go",
      [
        "tool",
        "oapi-codegen",
        "-config",
        temporaryConfig,
        contract.goInputPath,
      ],
      apiDir,
    );
  } finally {
    rmSync(temporaryConfig, { force: true });
  }
}

const temporaryDir = mkdtempSync(join(tmpdir(), "chaste-api-contracts-"));
try {
  for (const contract of contracts) {
    const temporaryTS = join(temporaryDir, contract.temporaryTS);
    const temporaryGo = join(temporaryDir, contract.temporaryGo);
    mkdirSync(dirname(contract.tsOutputPath), { recursive: true });
    mkdirSync(dirname(contract.goOutputPath), { recursive: true });
    generateTypeScript(
      contract,
      checkOnly ? temporaryTS : contract.tsOutputPath,
    );
    generateGo(contract, checkOnly ? temporaryGo : contract.goOutputPath);

    if (checkOnly) {
      const outputs = [
        ["TypeScript", contract.tsOutputPath, temporaryTS],
        ["Go", contract.goOutputPath, temporaryGo],
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
          `${contract.name} contract output is stale: ${stale.map(([language]) => language).join(", ")}\n`,
        );
        process.exitCode = 1;
      } else {
        process.stdout.write(`${contract.name} contract outputs current\n`);
      }
    } else {
      process.stdout.write(
        `Generated ${contract.name} TypeScript and Go API contract models\n`,
      );
    }
  }
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
