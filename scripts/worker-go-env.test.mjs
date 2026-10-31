import assert from "node:assert/strict";
import test from "node:test";
import { jobsWorkerEnvironment, jobsWorkerKeys, selectedEnvironment } from "./worker-go-env.mjs";

test("Go jobs worker environment forwards the OCR model from its allowlist", () => {
  const environment = selectedEnvironment(jobsWorkerKeys, {
    PATH: "/usr/bin",
    MODEL_OCR: "zai/nemotron-parse-v1.2",
    NVIDIA_API_KEY: "test-key",
    UNAPPROVED_SECRET: "must not pass through",
  });

  assert.equal(environment.MODEL_OCR, "zai/nemotron-parse-v1.2");
  assert.equal(environment.NVIDIA_API_KEY, "test-key");
  assert.equal(environment.UNAPPROVED_SECRET, undefined);
});

test("Go jobs worker keeps routine execution disabled by default", () => {
  const environment = jobsWorkerEnvironment({ PATH: "/usr/bin" });

  assert.equal(environment.GO_ROUTINE_SCHEDULER, "0");
  assert.equal(environment.GO_ROUTINE_AGENT_RUNNER, "0");
});

test("Go jobs worker preserves explicit routine agent runner opt-in", () => {
  const environment = jobsWorkerEnvironment({
    PATH: "/usr/bin",
    GO_ROUTINE_AGENT_RUNNER: "1",
    GO_ROUTINE_SCHEDULER: "0",
  });

  assert.equal(environment.GO_ROUTINE_AGENT_RUNNER, "1");
  assert.equal(environment.GO_ROUTINE_SCHEDULER, "0");
});

test("Go jobs worker preserves explicit routine scheduler opt-in", () => {
  const environment = jobsWorkerEnvironment({
    PATH: "/usr/bin",
    GO_ROUTINE_SCHEDULER: "1",
  });

  assert.equal(environment.GO_ROUTINE_SCHEDULER, "1");
  assert.equal(environment.GO_ROUTINE_AGENT_RUNNER, "0");
});
