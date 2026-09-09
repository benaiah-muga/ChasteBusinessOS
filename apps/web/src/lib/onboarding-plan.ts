/**
 * The onboarding plan, in one place, for the browser.
 *
 * Deliberately free of server imports: `server/onboarding.ts` pulls in the
 * database and the embedding client, and a wizard that imports it would drag
 * both into the client bundle. The step keys are mirrored from that module —
 * `ONBOARDING_STEPS` — and the two lists must stay identical, which is why
 * they are written out rather than derived.
 */

export const ONBOARDING_STEPS = [
  "business_profile",
  "import_customers",
  "import_products",
  "connect_source",
  "invite_team",
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];
export type StepStatus = "done" | "pending" | "skipped";
export type OnboardingPath = "fresh" | "import" | "connect";

export interface OnboardingState {
  path: OnboardingPath;
  steps: Partial<Record<OnboardingStepKey, StepStatus>>;
  startedAt: string;
  finishedAt?: string;
}

export interface StepMeta {
  /** Short name, shown in checklists and the wizard rail. */
  title: string;
  /** Why it is worth doing — the honest answer, not a nudge. */
  why: string;
  /** The concrete way to finish it from inside the app. */
  fix: { label: string; href: string };
}

export const STEP_META: Record<OnboardingStepKey, StepMeta> = {
  business_profile: {
    title: "Describe your business",
    why: "Your AI workmate reads this once and never asks again. Without it, it guesses.",
    fix: { label: "Write it in Settings", href: "/settings" },
  },
  import_customers: {
    title: "Bring in your customers",
    why: "Invoices, credit limits and payment reminders all hang off a customer record.",
    fix: { label: "Add customers", href: "/sales" },
  },
  import_products: {
    title: "Bring in your products",
    why: "Quotes and invoices price from your catalog instead of retyping every line.",
    fix: { label: "Add products", href: "/products" },
  },
  connect_source: {
    title: "Connect where your data lives",
    why: "Live connectors keep your books current without exporting files by hand.",
    fix: { label: "Review connections", href: "/settings" },
  },
  invite_team: {
    title: "Invite your team",
    why: "Everyone works under their own identity, so the audit trail names a person.",
    fix: { label: "Invite people", href: "/team" },
  },
};

export interface PathMeta {
  id: OnboardingPath;
  title: string;
  blurb: string;
  /** What this path asks for, so the choice is made with eyes open. */
  steps: OnboardingStepKey[];
  estimate: string;
}

export const PATH_META: Record<OnboardingPath, PathMeta> = {
  fresh: {
    id: "fresh",
    title: "Start from scratch",
    blurb: "Open a clean set of books. Add customers and products as you go.",
    steps: [],
    estimate: "About 2 minutes",
  },
  import: {
    id: "import",
    title: "Import a spreadsheet",
    blurb: "You already keep customers or products in a CSV or Excel file.",
    steps: ["import_customers", "import_products"],
    estimate: "About 5 minutes",
  },
  connect: {
    id: "connect",
    title: "Connect where your data lives",
    blurb: "Your records sit in another system — a store, an accounting tool, a database.",
    steps: ["connect_source"],
    estimate: "Varies",
  },
};

export const PATH_ORDER: OnboardingPath[] = ["fresh", "import", "connect"];
