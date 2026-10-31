import { spawn } from "node:child_process";
import console from "node:console";
import process from "node:process";

const child = spawn("go", ["-C", "apps/api", "run", "./cmd/api"], {
  stdio: "inherit",
  env: process.env,
});
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    child.kill(signal);
  });
}

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal && !stopping) process.kill(process.pid, signal);
  else process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
