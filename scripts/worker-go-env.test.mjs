import assert from "node:assert/strict";
import test from "node:test";
import { jobsWorkerKeys, selectedEnvironment } from "./worker-go-env.mjs";

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
