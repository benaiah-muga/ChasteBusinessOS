import type { AgentSessionEventType, SessionLog } from "../trajectory/index.js";
import { sessionEvent } from "../trajectory/index.js";
import { forkSession } from "./fork.js";
import type { ForkResult } from "./fork.js";
import { replaySession } from "./replay.js";
import type { ReplayTrace } from "./replay.js";

/**
 * Evaluation harness (research doc §Evaluation and Testing, build item 14).
 *
 * A `Scenario` is a self-contained regression test: a driver that exercises
 * real harness behavior against an isolated session, recording everything on
 * the session log and declaring pass/fail checks. The runner turns the log
 * into an evaluation result by additionally *replaying* it (the hard
 * reconstruction invariant) and *forking* it (first-class replay/fork), so a
 * suite run doubles as a regression suite: golden business scenarios, policy
 * refusals, and replay tests all share one deterministic runner.
 */

export interface ScenarioCheck {
  label: string;
  passed: boolean;
  detail?: string;
}

export interface ScenarioContext {
  sessionId: string;
  organizationId: string;
  log: SessionLog;
  now: () => Date;
  /** Append a durable trajectory event to this scenario's session log. */
  record(type: AgentSessionEventType, payload: unknown): Promise<void>;
  /** Declare a pass/fail assertion on the scenario's observable behavior. */
  check(label: string, passed: boolean, detail?: string): void;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  run(ctx: ScenarioContext): Promise<void>;
}

/** Build an isolated scenario context whose `record` appends to the log. */
export function createScenarioContext(opts: {
  sessionId: string;
  organizationId: string;
  log: SessionLog;
  now?: () => Date;
}): ScenarioContext {
  const now = opts.now ?? (() => new Date());
  return {
    sessionId: opts.sessionId,
    organizationId: opts.organizationId,
    log: opts.log,
    now,
    async record(type, payload) {
      await opts.log.append(
        sessionEvent(opts.sessionId, opts.organizationId, type, payload, { now }),
      );
    },
    check() {},
  };
}

export interface ScenarioResult {
  id: string;
  name: string;
  passed: boolean;
  checks: ScenarioCheck[];
  totalEvents: number;
  replay: ReplayTrace;
  forkedSessionId?: string;
  fork?: ForkResult;
  error?: string;
  durationMs: number;
}

export interface SuiteReport {
  passed: boolean;
  results: ScenarioResult[];
  passedCount: number;
  failedCount: number;
  durationMs: number;
}

/** Run one scenario and attach the replay + fork guarantees to its verdict. */
export async function runScenario(
  scenario: Scenario,
  ctx: ScenarioContext,
): Promise<ScenarioResult> {
  const started = Date.now();
  const checks: ScenarioCheck[] = [];
  const context: ScenarioContext = {
    ...ctx,
    check: (label, passed, detail) => checks.push({ label, passed, detail }),
  };

  try {
    await scenario.run(context);

    // Replay guarantee: the produced trajectory must reconstruct into a
    // complete model-visible request. This is the hard invariant as a check.
    const replay = await replaySession(ctx.log, ctx.sessionId);
    checks.push({
      label: "replay: session log reconstructs the model-visible request",
      passed: replay.complete,
      detail: replay.gaps.join("; ") || undefined,
    });

    // Fork guarantee: a trajectory can be forked at its boundary and the fork
    // carries the same events, replayed under a fresh identity.
    const fork = await forkSession(ctx.log, ctx.sessionId, {
      newSessionId: `${ctx.sessionId}--fork`,
      uptoSeq: replay.totalEvents,
      organizationId: ctx.organizationId,
      forkedByUserId: ctx.organizationId,
      reason: "scenario regression fork",
      now: ctx.now,
    });
    checks.push({
      label: `fork: boundary ${fork.uptoSeq} copied ${fork.copied} of ${replay.totalEvents} events`,
      passed: fork.copied === replay.totalEvents,
      detail: fork.sessionId,
    });

    const passed = checks.every((c) => c.passed);
    return {
      id: scenario.id,
      name: scenario.name,
      passed,
      checks,
      totalEvents: replay.totalEvents,
      replay,
      forkedSessionId: fork.sessionId,
      fork,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    checks.push({
      label: "scenario run",
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      id: scenario.id,
      name: scenario.name,
      passed: false,
      checks,
      totalEvents: 0,
      replay: {
        sessionId: ctx.sessionId,
        totalEvents: 0,
        reconstructed: {
          sessionId: ctx.sessionId,
          systemPromptSections: [],
          messages: [],
          toolSchemas: [],
          evidenceRefs: [],
          memoryReads: [],
          policyDecisions: [],
          contextBundleIds: [],
          modelRoutes: [],
          complete: false,
          gaps: [],
        },
        gaps: [],
        complete: false,
      },
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}

/** Run a regression suite; each scenario gets its own isolated context. */
export async function runScenarioSuite(
  scenarios: Scenario[],
  makeContext: (scenario: Scenario) => ScenarioContext,
): Promise<SuiteReport> {
  const started = Date.now();
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, makeContext(scenario)));
  }
  const passedCount = results.filter((r) => r.passed).length;
  return {
    passed: passedCount === results.length,
    results,
    passedCount,
    failedCount: results.length - passedCount,
    durationMs: Date.now() - started,
  };
}