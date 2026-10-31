import { readFileSync } from "node:fs";
import process from "node:process";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const verifyWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
const pullRequestTemplate = readFileSync(".github/pull_request_template.md", "utf8");
const readme = readFileSync("README.md", "utf8");
const errors = [];

function workflowRunCommands(workflow) {
  const lines = workflow.split(/\r?\n/);
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*)$/.exec(lines[index] ?? "");
    if (!match) continue;
    const indent = match[1]?.length ?? 0;
    const value = match[2]?.trim() ?? "";
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      for (index += 1; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= indent) {
          index -= 1;
          break;
        }
        const command = line.trim();
        if (command && !command.startsWith("#")) commands.push(command);
      }
    } else if (value && !value.startsWith("#")) {
      commands.push(value.replace(/^(['"])(.*)\1$/, "$2"));
    }
  }
  return commands;
}

const runCommands = workflowRunCommands(verifyWorkflow);
const hasCommand = (required) => runCommands.some((command) => command === required);

const gate = packageJson.scripts?.["verify:vite-go"] ?? "";
for (const required of [
  "@chaste/web-vite build",
  "go:verify",
]) {
  if (!gate.includes(required)) errors.push(`verify:vite-go is missing: ${required}`);
}

for (const required of [
  "pnpm verify:vite-go",
  "pnpm migration:data:check",
  "pnpm migration:inventory:check",
  "pnpm migration:routes:check",
  "pnpm migration:actions:check",
  "pnpm migration:capabilities:check",
  "pnpm migration:contracts:check",
  "pnpm demo:slice",
  "pnpm demo:m4",
  "pnpm demo:m5",
  "pnpm typecheck",
  "pnpm lint",
  "pnpm test",
]) {
  if (!hasCommand(required)) errors.push(`CI is missing run command: ${required}`);
}

for (const required of [
  "pnpm --filter @chaste/db db:migrate",
  "pnpm db:provision-runtime",
  "pnpm demo:slice",
  "pnpm demo:m4",
  "pnpm demo:m5",
]) {
  if (!hasCommand(required)) errors.push(`CI is missing run command: ${required}`);
}

if (!/^\s*if:\s*\$\{\{\s*env\.NVIDIA_API_KEY\s*!=\s*''\s*\}\}\s*$/m.test(verifyWorkflow)) {
  errors.push("CI live demos are missing the NVIDIA_API_KEY guard");
}

if (runCommands.some((command) => /^pnpm --filter web build(?:\s|$)/.test(command))) {
  errors.push("CI still requires the Next.js production build");
}

if (!pullRequestTemplate.includes("pnpm verify:vite-go")) {
  errors.push("PR template does not request pnpm verify:vite-go");
}
if (!readme.includes("`pnpm verify:vite-go` builds the active Vite client")) {
  errors.push("README does not describe the active Vite and Go verification command");
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Vite/Go CI contract is valid.\n");
}
