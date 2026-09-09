import { describe, expect, it } from "vitest";
import {
  MIN_DESCRIPTION,
  deferredSteps,
  failureFromResponse,
  isCurrencyReady,
  isDescriptionReady,
  isInviteReady,
  isOrgNameReady,
  isProfileReady,
  networkFailure,
  railScreens,
  readyInvites,
  recoveryFor,
  resolveBaseCurrency,
  screensForPath,
} from "@/lib/onboarding-flow";

/**
 * The wizard's rules, without React.
 *
 * These are the decisions a user feels directly: which screen comes next,
 * whether the thing they typed is enough to open a set of books, and what an
 * error actually says. The failure-mapping cases matter more than they look —
 * a wrong hint sends someone to sign in again when they should be waiting out
 * a rate limit, and a shared table that one request can mutate leaks the
 * previous user's message into the next one.
 */

describe("screensForPath", () => {
  it("skips the data screen for 'start from scratch'", () => {
    expect(screensForPath("fresh")).toEqual(["path", "profile", "team", "done"]);
  });

  it("includes the data screen for the import path", () => {
    expect(screensForPath("import")).toEqual(["path", "profile", "data", "team", "done"]);
  });

  it("includes the data screen for the connect path", () => {
    expect(screensForPath("connect")).toEqual(["path", "profile", "data", "team", "done"]);
  });

  it("keeps the data screen before a path is chosen, so the rail does not resize on choice", () => {
    expect(screensForPath(null)).toEqual(["path", "profile", "data", "team", "done"]);
  });

  it("always ends on the done screen", () => {
    for (const path of ["fresh", "import", "connect", null] as const) {
      expect(screensForPath(path).at(-1)).toBe("done");
    }
  });
});

describe("railScreens", () => {
  it("drops the terminal screen, because it is a result rather than a step", () => {
    expect(railScreens(["path", "profile", "data", "team", "done"])).toEqual([
      "path",
      "profile",
      "data",
      "team",
    ]);
  });
});

describe("resolveBaseCurrency", () => {
  it("passes a chosen currency through unchanged", () => {
    expect(resolveBaseCurrency("USD", "")).toBe("USD");
  });

  it("upper-cases and trims a hand-typed 'other' currency", () => {
    expect(resolveBaseCurrency("other", "  ngn  ")).toBe("NGN");
  });

  it("resolves to empty when 'other' is chosen but nothing is typed yet", () => {
    expect(resolveBaseCurrency("other", "")).toBe("");
  });

  it("ignores a custom value while a real currency is selected", () => {
    expect(resolveBaseCurrency("GBP", "NGN")).toBe("GBP");
  });
});

describe("isDescriptionReady", () => {
  it("accepts exactly the minimum length", () => {
    expect(isDescriptionReady("a".repeat(MIN_DESCRIPTION))).toBe(true);
  });

  it("rejects one character short of the minimum", () => {
    expect(isDescriptionReady("a".repeat(MIN_DESCRIPTION - 1))).toBe(false);
  });

  it("counts trimmed length, so padding does not buy a submission", () => {
    expect(isDescriptionReady(`   ${"a".repeat(MIN_DESCRIPTION - 1)}   `)).toBe(false);
  });

  it("rejects an empty description", () => {
    expect(isDescriptionReady("")).toBe(false);
  });
});

describe("isOrgNameReady", () => {
  it("needs at least two characters", () => {
    expect(isOrgNameReady("A")).toBe(false);
    expect(isOrgNameReady("AB")).toBe(true);
  });

  it("does not accept a name of only spaces", () => {
    expect(isOrgNameReady("   ")).toBe(false);
  });
});

describe("isCurrencyReady", () => {
  it("requires a three-letter code", () => {
    expect(isCurrencyReady("USD")).toBe(true);
    expect(isCurrencyReady("US")).toBe(false);
    expect(isCurrencyReady("USDD")).toBe(false);
    expect(isCurrencyReady("")).toBe(false);
  });
});

describe("isProfileReady", () => {
  const good = { name: "Glow Works", description: "x".repeat(MIN_DESCRIPTION), currency: "USD" };

  it("accepts a complete profile", () => {
    expect(isProfileReady(good.name, good.description, good.currency)).toBe(true);
  });

  it("refuses a one-character business name", () => {
    expect(isProfileReady("G", good.description, good.currency)).toBe(false);
  });

  it("refuses a too-short description", () => {
    expect(isProfileReady(good.name, "too short", good.currency)).toBe(false);
  });

  it("refuses an unfinished custom currency", () => {
    expect(isProfileReady(good.name, good.description, "NG")).toBe(false);
  });
});

describe("deferredSteps", () => {
  it("surfaces steps left pending", () => {
    expect(deferredSteps({ import_customers: "pending" })).toEqual(["import_customers"]);
  });

  it("surfaces steps explicitly skipped", () => {
    expect(deferredSteps({ connect_source: "skipped" })).toEqual(["connect_source"]);
  });

  it("excludes steps that are done", () => {
    expect(deferredSteps({ import_customers: "done", invite_team: "skipped" })).toEqual(["invite_team"]);
  });

  it("returns nothing when there is nothing outstanding", () => {
    expect(deferredSteps({})).toEqual([]);
    expect(deferredSteps({ business_profile: "done" })).toEqual([]);
  });
});

describe("invite validation", () => {
  it("accepts an email with a role", () => {
    expect(isInviteReady({ email: "ada@example.com", roleId: "role-1" })).toBe(true);
  });

  it("rejects an email with no role chosen", () => {
    expect(isInviteReady({ email: "ada@example.com", roleId: "" })).toBe(false);
  });

  it("rejects a malformed email", () => {
    expect(isInviteReady({ email: "ada@example", roleId: "role-1" })).toBe(false);
    expect(isInviteReady({ email: "ada", roleId: "role-1" })).toBe(false);
  });

  it("trims the address before checking it", () => {
    expect(isInviteReady({ email: "  ada@example.com  ", roleId: "role-1" })).toBe(true);
  });

  it("filters a list down to the sendable ones", () => {
    const invites = [
      { email: "ada@example.com", roleId: "r1" },
      { email: "alan@example.com", roleId: "" },
      { email: "not-an-email", roleId: "r1" },
    ];
    expect(readyInvites(invites)).toEqual([{ email: "ada@example.com", roleId: "r1" }]);
  });
});

describe("recoveryFor", () => {
  it("sends an expired session to sign in again", () => {
    expect(recoveryFor("unauthorized")).toBe("signin");
  });

  it("sends someone who already has a workspace to their dashboard", () => {
    expect(recoveryFor("already_onboarded")).toBe("dashboard");
  });

  it("offers a retry for everything else", () => {
    expect(recoveryFor("rate_limited")).toBe("retry");
    expect(recoveryFor("not_found")).toBe("retry");
    expect(recoveryFor("network")).toBe("retry");
    expect(recoveryFor("500")).toBe("retry");
  });
});

describe("failureFromResponse", () => {
  const url = "/api/onboarding";

  it("explains a known code in plain language", () => {
    const f = failureFromResponse(401, { code: "unauthorized" }, "POST", url);
    expect(f.code).toBe("unauthorized");
    expect(f.title).toBe("Your session ended");
    expect(f.hint).toContain("Sign in again");
  });

  it("falls back to the status when the body carries no code", () => {
    expect(failureFromResponse(500, {}, "POST", url).code).toBe("500");
  });

  it("gives an unknown code a title that does not blame the user", () => {
    const f = failureFromResponse(422, { code: "weird" }, "PATCH", url);
    expect(f.title).toBe("That didn't work");
    expect(f.hint).toBe("Nothing was changed. Try again in a moment.");
  });

  it("repeats a short, clean server message instead of a generic one", () => {
    const f = failureFromResponse(422, { code: "boom", error: "That business name is taken." }, "POST", url);
    expect(f.hint).toBe("That business name is taken.");
  });

  it("does not repeat a message long enough to be a dump", () => {
    const f = failureFromResponse(422, { code: "boom", error: "x".repeat(161) }, "POST", url);
    expect(f.hint).toBe("Nothing was changed. Try again in a moment.");
  });

  it("does not leak JSON or markup into the UI", () => {
    const f = failureFromResponse(422, { code: "boom", error: '{"sql":"select 1"}' }, "POST", url);
    expect(f.hint).toBe("Nothing was changed. Try again in a moment.");
  });

  it("prefers the server's countdown for a rate limit", () => {
    const f = failureFromResponse(429, { code: "rate_limited", error: "Try again in 30 seconds." }, "POST", url);
    expect(f.hint).toBe("Try again in 30 seconds.");
  });

  /* One request must not be able to edit the shared table for the next one:
     the countdown belongs to the request that was throttled, not to every
     later failure that happens to share the code. */
  it("does not carry one rate-limit message into the next failure", () => {
    const first = failureFromResponse(429, { code: "rate_limited", error: "Try again in 30 seconds." }, "POST", url);
    expect(first.hint).toBe("Try again in 30 seconds.");
    const second = failureFromResponse(429, { code: "rate_limited" }, "POST", url);
    expect(second.hint).toBe("Wait a moment and try again.");
  });

  it("records the request that failed for support, without showing it as the message", () => {
    const f = failureFromResponse(422, { code: "boom" }, "PATCH", url);
    expect(f.detail).toBe(`PATCH ${url} → 422\n{"code":"boom"}`);
  });

  it("carries a retry delay when the server sends one", () => {
    const f = failureFromResponse(429, { code: "rate_limited", retryAfterSec: 30 }, "POST", url);
    expect(f.retryAfterSec).toBe(30);
  });

  it("leaves the retry delay undefined when the server sends none", () => {
    expect(failureFromResponse(429, { code: "rate_limited" }, "POST", url).retryAfterSec).toBeUndefined();
  });

  it("ignores a retry delay that is not a number", () => {
    const f = failureFromResponse(429, { code: "rate_limited", retryAfterSec: "soon" }, "POST", url);
    expect(f.retryAfterSec).toBeUndefined();
  });
});

describe("networkFailure", () => {
  it("blames the connection, not the user, and promises nothing was lost", () => {
    const f = networkFailure(new Error("offline"));
    expect(f.code).toBe("network");
    expect(f.title).toBe("Can't reach the server");
    expect(f.hint).toContain("nothing has been lost");
  });

  it("keeps the underlying error for the detail line", () => {
    expect(networkFailure(new Error("offline")).detail).toContain("offline");
  });
});
