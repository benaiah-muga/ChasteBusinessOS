import type { OnboardingPath, OnboardingStepKey, StepStatus } from "@/lib/onboarding-plan";

/**
 * The decisions the setup wizard makes, with React and the network taken out.
 *
 * Kept separate from `onboarding-plan.ts` (which is the *content* of the steps)
 * and from `components/onboarding/wizard.tsx` (which is the markup) so the
 * rules that decide where a user goes next, what they are allowed to submit,
 * and how a failure is explained can be tested without rendering anything.
 */

export type Screen = "path" | "profile" | "data" | "team" | "done";

/** Shortest business description we accept: long enough to be useful to the agent. */
export const MIN_DESCRIPTION = 20;

/**
 * The screens a path walks through. "Start from scratch" has nothing to
 * import, so it skips the data screen entirely; every other path — including
 * no choice yet — keeps it.
 */
export function screensForPath(path: OnboardingPath | null): Screen[] {
  return path === "fresh"
    ? ["path", "profile", "team", "done"]
    : ["path", "profile", "data", "team", "done"];
}

/** The rail shows progress, so the terminal screen is not one of the steps. */
export function railScreens(screens: Screen[]): Screen[] {
  return screens.filter((s) => s !== "done");
}

/** "Other" currencies arrive as free text and are normalised to ISO uppercase. */
export function resolveBaseCurrency(currency: string, customCurrency: string): string {
  return currency === "other" ? customCurrency.trim().toUpperCase() : currency;
}

export function isDescriptionReady(description: string): boolean {
  return description.trim().length >= MIN_DESCRIPTION;
}

export function isOrgNameReady(orgName: string): boolean {
  return orgName.trim().length >= 2;
}

/** Currency is chosen once and stored as integer minor units, so it must be a real ISO code. */
export function isCurrencyReady(resolvedCurrency: string): boolean {
  return resolvedCurrency.length === 3;
}

/** Everything the wizard can submit on the profile screen. */
export function isProfileReady(orgName: string, description: string, resolvedCurrency: string): boolean {
  return isOrgNameReady(orgName) && isDescriptionReady(description) && isCurrencyReady(resolvedCurrency);
}

/**
 * Steps left `pending` or `skipped`, in the order they were recorded. These
 * come back on the dashboard: "skipped" must never quietly become "lost".
 */
export function deferredSteps(
  stepStatus: Partial<Record<OnboardingStepKey, StepStatus>>,
): OnboardingStepKey[] {
  return (Object.keys(stepStatus) as OnboardingStepKey[]).filter(
    (k) => stepStatus[k] === "pending" || stepStatus[k] === "skipped",
  );
}

export function isInviteReady(invite: { email: string; roleId: string }): boolean {
  return /.+@.+\..+/.test(invite.email.trim()) && Boolean(invite.roleId);
}

export function readyInvites(invites: { email: string; roleId: string }[]): { email: string; roleId: string }[] {
  return invites.filter(isInviteReady);
}

export interface Failure {
  code: string;
  title: string;
  hint: string;
  detail?: string;
  retryAfterSec?: number;
}

/** Which way out the wizard offers for a given failure. */
export type Recovery = "signin" | "dashboard" | "retry";

export function recoveryFor(code: string): Recovery {
  if (code === "unauthorized") return "signin";
  if (code === "already_onboarded") return "dashboard";
  return "retry";
}

const KNOWN_FAILURES: Record<string, { title: string; hint: string }> = {
  unauthorized: { title: "Your session ended", hint: "Sign in again and you'll pick up right here." },
  already_onboarded: { title: "You already have a workspace", hint: "Nothing to set up — your books are open." },
  rate_limited: { title: "Too many attempts", hint: "Wait a moment and try again." },
  not_found: { title: "Set up your workspace first", hint: "This step needs a workspace to attach to." },
};

/**
 * Turns an unsuccessful response into something a person can act on.
 *
 * A server message is only repeated when it reads like a sentence — short, and
 * free of the braces and angle brackets that leak JSON and markup into the UI.
 */
export function failureFromResponse(
  status: number,
  body: Record<string, unknown>,
  method: string,
  url: string,
): Failure {
  const code = String(body.code ?? String(status));
  const message = String(body.error ?? "");
  const known = KNOWN_FAILURES[code];
  const friendly = known ?? {
    title: "That didn't work",
    hint:
      message && message.length <= 160 && !/[{}<>]/.test(message)
        ? message
        : "Nothing was changed. Try again in a moment.",
  };
  return {
    code,
    title: friendly.title,
    // The server's own copy already carries the countdown; don't overwrite it.
    // (Read, not assigned: KNOWN_FAILURES is shared across every call.)
    hint: code === "rate_limited" && message ? message : friendly.hint,
    detail: `${method} ${url} → ${status}\n${JSON.stringify(body)}`,
    retryAfterSec: typeof body.retryAfterSec === "number" ? body.retryAfterSec : undefined,
  };
}

export function networkFailure(err: unknown): Failure {
  return {
    code: "network",
    title: "Can't reach the server",
    hint: "Check your connection and try again — nothing has been lost.",
    detail: String(err),
  };
}
