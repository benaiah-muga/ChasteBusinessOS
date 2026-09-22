"use client";

import type { WorkerLinter } from "harper.js";

/**
 * Shared Harper spell/grammar linter for writing surfaces (Phase 4).
 * harper.js runs its own Web Worker internally (WorkerLinter), so the WASM
 * never touches the main thread and nothing Rust-related ships in the
 * server container. Lazy: the worker spins up on first lint.
 *
 * The user dictionary is device-local (localStorage) per the Phase 4
 * design: "add to dictionary" never syncs anywhere.
 */

const DICT_KEY = "chaste-harper-dict";

let linterPromise: Promise<WorkerLinter> | null = null;
let linter: WorkerLinter | null = null;

/** True when the current environment can run the linter at all. */
export function writingAidsSupported(): boolean {
  return typeof window !== "undefined" && "Worker" in window;
}

async function getLinter(): Promise<WorkerLinter> {
  if (linter) return linter;
  if (!linterPromise) {
    linterPromise = (async () => {
      const [{ WorkerLinter: W }] = await Promise.all([import("harper.js"), import("harper.js/slimBinary")]);
      const { slimBinary } = await import("harper.js/slimBinary");
      linter = new W({ binary: slimBinary });
      await linter.setup();
      return linter;
    })();
  }
  return linterPromise;
}

export interface WritingLint {
  /** Offset into the text that was linted. */
  start: number;
  end: number;
  problemText: string;
  /** Replacement candidates as plain strings. */
  suggestions: string[];
}

export function readUserDictionary(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(DICT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function addToUserDictionary(word: string): void {
  const lower = word.toLowerCase();
  const words = readUserDictionary();
  if (!words.some((w) => w.toLowerCase() === lower)) words.push(word);
  try {
    localStorage.setItem(DICT_KEY, JSON.stringify(words));
  } catch {
    // Device storage unavailable; the suggestion stays for this session.
  }
}

interface HarperLintShape {
  span(): { start: number; end: number };
  get_problem_text(): string;
  suggestions(): Array<{ get_text(): string }>;
}

/**
 * Lint a block of prose. Debounce on the caller's side (recommended
 * ~400ms); the worker absorbs the cost. Offsets index into `text`.
 */
export async function lintText(text: string): Promise<WritingLint[]> {
  if (!writingAidsSupported()) return [];
  const dict = new Set(readUserDictionary().map((w) => w.toLowerCase()));
  try {
    const l = await getLinter();
    const lints = (await l.lint(text)) as unknown as HarperLintShape[];
    return lints
      .filter((lint) => !dict.has(lint.get_problem_text().toLowerCase()))
      .map((lint) => ({
        start: lint.span().start,
        end: lint.span().end,
        problemText: lint.get_problem_text(),
        suggestions: lint.suggestions().map((s) => s.get_text()).slice(0, 4),
      }))
      .slice(0, 60);
  } catch {
    return [];
  }
}
