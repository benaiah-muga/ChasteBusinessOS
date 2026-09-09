"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { callApi, postApi } from "@/lib/api";
import { CURRENCIES } from "@/lib/prefs";
import { cn } from "@/lib/format";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBookOpen,
  IconBox,
  IconBuilding,
  IconCash,
  IconCheck,
  IconChevronLeft,
  IconFileText,
  IconLandmark,
  IconLink,
  IconShieldCheck,
  IconSparkle,
  IconStore,
  IconTrash,
  IconUsers,
} from "@/components/icons";
import {
  PATH_META,
  PATH_ORDER,
  STEP_META,
  type OnboardingPath,
  type OnboardingStepKey,
  type StepStatus,
} from "@/lib/onboarding-plan";
import {
  MIN_DESCRIPTION,
  isDescriptionReady,
  isProfileReady,
  networkFailure,
  failureFromResponse,
  deferredSteps,
  railScreens,
  readyInvites,
  recoveryFor,
  resolveBaseCurrency,
  screensForPath,
  type Failure,
  type Screen,
} from "@/lib/onboarding-flow";
import { CsvImportPanel } from "./csv-import";
import {
  ChoiceCard,
  OnboardingHeader,
  RecoverBlock,
  Spinner,
  StepRail,
  ghostButtonClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "./parts";

/**
 * Setup wizard.
 *
 * Three rules drove this:
 *  1. A new user should never have to guess what a step wants or why it exists.
 *  2. Every failure says what happened and offers the way out, as a button.
 *  3. Anything skippable is *remembered*, not dropped — deferred steps come
 *     back as a checklist on the dashboard.
 */

/** Wraps fetch so every caller deals in data-or-failure, never in thrown JSON. */
async function request(url: string, init: RequestInit): Promise<{ ok: true; data: unknown } | { ok: false; failure: Failure }> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return { ok: false, failure: networkFailure(err) };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty bodies are fine on 204s; the shape guards below handle the rest */
  }
  if (res.ok) return { ok: true, data: body };
  return { ok: false, failure: failureFromResponse(res.status, body, init.method ?? "GET", url) };
}

const CREATE_PROGRESS = [
  "Reading your description…",
  "Seeding your chart of accounts…",
  "Opening your books, balanced at zero…",
  "Handing you the owner keys…",
];

const DESCRIPTION_STARTERS = [
  "We sell ",
  "We manufacture ",
  "We install and service ",
  "We run a ",
];

export function OnboardingWizard({ email }: { email: string }) {
  const router = useRouter();

  const [screen, setScreen] = useState<Screen>("path");
  const [path, setPath] = useState<OnboardingPath | null>(null);

  const [orgName, setOrgName] = useState("");
  const [currency, setCurrency] = useState<string>("USD");
  const [customCurrency, setCustomCurrency] = useState("");
  const [description, setDescription] = useState("");

  const [creating, setCreating] = useState(false);
  const [progressStep, setProgressStep] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);

  const [stepStatus, setStepStatus] = useState<Partial<Record<OnboardingStepKey, StepStatus>>>({});
  const [imported, setImported] = useState<{ customers: number; products: number }>({
    customers: 0,
    products: 0,
  });

  const [connectMode, setConnectMode] = useState<"choose" | "csv">("choose");
  const [connectNote, setConnectNote] = useState<string | null>(null);

  const [invites, setInvites] = useState<{ email: string; roleId: string }[]>([{ email: "", roleId: "" }]);
  const [roles, setRoles] = useState<{ id: string; name: string; isSystem: boolean }[]>([]);
  const [rolesFailed, setRolesFailed] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteOutcomes, setInviteOutcomes] = useState<{ email: string; ok: boolean; note: string }[]>([]);

  const [finishing, setFinishing] = useState(false);

  /* Cycle the progress copy while the org is being created. Seeding accounts
     and embedding the profile takes a few seconds; a motionless button reads
     as a hang. */
  useEffect(() => {
    if (!creating) return;
    setProgressStep(0);
    const id = setInterval(() => setProgressStep((i) => Math.min(i + 1, CREATE_PROGRESS.length - 1)), 2400);
    return () => clearInterval(id);
  }, [creating]);

  /* Load roles once the workspace exists, so the invite step offers real ones. */
  useEffect(() => {
    if (screen !== "team" || roles.length > 0) return;
    void callApi<{ roles?: { id: string; name: string; isSystem: boolean }[] }>("/api/team").then((res) => {
      if (res.ok && res.data?.roles) setRoles(res.data.roles);
      else setRolesFailed(true);
    });
  }, [screen, roles.length]);

  const screens = useMemo<Screen[]>(() => screensForPath(path), [path]);
  const screenIndex = screens.indexOf(screen);
  const rail = railScreens(screens).map((s) => ({
    key: s,
    label: s === "path" ? "How you'll start" : s === "profile" ? "Your business" : s === "data" ? "Your data" : "Your team",
  }));

  const resolvedCurrency = resolveBaseCurrency(currency, customCurrency);
  const descriptionReady = isDescriptionReady(description);

  async function markStep(key: OnboardingStepKey, status: StepStatus) {
    setStepStatus((prev) => ({ ...prev, [key]: status }));
    const res = await request("/api/onboarding", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step: key, status }),
    });
    if (!res.ok) {
      // The step is still marked locally; a failed write only means the
      // checklist may offer it again, which is the safe direction to fail in.
      console.warn("onboarding step not persisted", res.failure);
    }
  }

  async function createWorkspace() {
    setCreating(true);
    setFailure(null);
    const res = await request("/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgName: orgName.trim(),
        businessDescription: description.trim(),
        baseCurrency: resolvedCurrency,
        path: path ?? "fresh",
        deferredSteps: path ? PATH_META[path].steps : [],
      }),
    });
    setCreating(false);
    if (!res.ok) {
      setFailure(res.failure);
      return;
    }
    await markStep("business_profile", "done");
    setScreen(path === "fresh" ? "team" : "data");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function finish() {
    setFinishing(true);
    await request("/api/onboarding", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ complete: true }),
    });
    setFinishing(false);
    router.push("/");
    router.refresh();
  }

  async function sendInvites() {
    const valid = readyInvites(invites);
    if (valid.length === 0) return;
    setInviting(true);
    setInviteOutcomes([]);
    const outcomes: { email: string; ok: boolean; note: string }[] = [];
    for (const inv of valid) {
      const res = await postApi<{ ok?: boolean; pendingApproval?: boolean; reason?: string }>("/api/team", {
        action: "invite",
        email: inv.email.trim(),
        roleId: inv.roleId,
      });
      if (!res.ok) {
        outcomes.push({ email: inv.email, ok: false, note: res.error?.hint ?? "Couldn't send that one." });
      } else if (res.data?.pendingApproval) {
        outcomes.push({
          email: inv.email,
          ok: true,
          note: "Queued for approval — it lands in the Approvals inbox first.",
        });
      } else {
        outcomes.push({ email: inv.email, ok: true, note: "Invited." });
      }
    }
    setInviteOutcomes(outcomes);
    setInviting(false);
    if (outcomes.some((o) => o.ok)) await markStep("invite_team", "done");
  }

  const deferred = deferredSteps(stepStatus);

  /* ── Right-hand column: what this step does and why it is safe ────────── */

  const aside = (() => {
    switch (screen) {
      case "path":
        return {
          eyebrow: "Step 1 of " + (screens.length - 1),
          title: "Nothing here is locked in",
          body: "Pick the closest match. Every one of these can be done later, changed, or done twice — the books don't care which door you came in by.",
          points: [
            { icon: <IconLandmark className="size-4" />, text: "Your chart of accounts is seeded either way." },
            { icon: <IconShieldCheck className="size-4" />, text: "You stay the owner, whatever you choose." },
          ],
        };
      case "profile":
        return {
          eyebrow: "Step 2 of " + (screens.length - 1),
          title: "Why we ask for a paragraph",
          body: "This is the only time the platform asks you to explain your business in prose. Describe it the way you would to a new bookkeeper.",
          points: [
            { icon: <IconSparkle className="size-4" />, text: "Your AI workmate reads it once and remembers it." },
            { icon: <IconLandmark className="size-4" />, text: "A standard chart of accounts is created and balanced at zero." },
            { icon: <IconShieldCheck className="size-4" />, text: "You become the owner, with authority over every gated action." },
          ],
        };
      case "data":
        return {
          eyebrow: "Step 3 of " + (screens.length - 1),
          title: path === "import" ? "Your file stays yours" : "About connections",
          body:
            path === "import"
              ? "We read the file in your browser first and show you exactly what will land before anything is written. Duplicate customers are skipped, not duplicated."
              : "Some connections are live today, others are still being built. We'd rather tell you which is which than offer a button that does nothing.",
          points:
            path === "import"
              ? [
                  { icon: <IconCheck className="size-4" />, text: "One bad row never cancels the whole import." },
                  { icon: <IconFileText className="size-4" />, text: "Anything unmatched is listed by row number." },
                ]
              : [
                  { icon: <IconCash className="size-4" />, text: "Bank accounts and statement imports are live." },
                  { icon: <IconStore className="size-4" />, text: "Store and accounting connectors are still on the way." },
                ],
        };
      case "team":
        return {
          eyebrow: "Step " + (screenIndex + 1) + " of " + (screens.length - 1),
          title: "Why identities matter here",
          body: "Everyone acts under their own name, so the audit trail can always answer who did what — including the AI. That is the whole point of the system.",
          points: [
            { icon: <IconUsers className="size-4" />, text: "Invites carry a role, and roles carry authority." },
            { icon: <IconBookOpen className="size-4" />, text: "Every action is hash-chained to a person or an agent." },
          ],
        };
      default:
        return {
          eyebrow: "All done",
          title: "Your books are open",
          body: "You can change anything you set up here, at any time, from Settings.",
          points: [
            { icon: <IconLandmark className="size-4" />, text: "Chart of accounts seeded, balanced at zero." },
            { icon: <IconShieldCheck className="size-4" />, text: "You are the owner. Nothing acts without your say." },
          ],
        };
    }
  })();

  return (
    <div className="min-h-screen bg-sand-50 font-display text-ink">
      <OnboardingHeader email={email} />

      <main className="mx-auto max-w-7xl px-5 py-8">
        <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
          <StepRail steps={rail} current={Math.min(screenIndex, rail.length - 1)} />
          {screen !== "done" && (
            <p className="text-[12px] text-ink-muted">
              Everything here can be changed later in{" "}
              <Link href="/settings" className="font-medium text-gold-700 underline-offset-2 hover:underline">
                Settings
              </Link>
              .
            </p>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.25fr_1fr] lg:items-start">
          {/* ── The step ────────────────────────────────────────────────── */}
          <section className="rounded-xl bg-cream p-6 shadow-md ring-1 ring-sand-200 sm:p-8">
            {failure && (
              <div className="mb-5">
                <RecoverBlock title={failure.title}>
                  {failure.hint}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {recoveryFor(failure.code) === "signin" && (
                      <Link href="/login" className={cn(primaryButtonClass, "h-9 w-auto px-3.5 text-[13px]")}>
                        Sign in again
                      </Link>
                    )}
                    {recoveryFor(failure.code) === "dashboard" && (
                      <Link href="/" className={cn(primaryButtonClass, "h-9 w-auto px-3.5 text-[13px]")}>
                        Open my dashboard
                      </Link>
                    )}
                    {recoveryFor(failure.code) === "retry" && (
                      <button
                        type="button"
                        onClick={() => {
                          setFailure(null);
                          if (screen === "profile") void createWorkspace();
                        }}
                        className={cn(primaryButtonClass, "h-9 w-auto px-3.5 text-[13px]")}
                      >
                        Try again
                      </button>
                    )}
                  </div>
                </RecoverBlock>
              </div>
            )}

            {screen === "path" && (
              <div>
                <h1 className="text-[26px] leading-tight font-bold tracking-tight">How would you like to start?</h1>
                <p className="mt-1.5 text-sm text-ink-muted">
                  There is no wrong answer — this only decides what we offer you next.
                </p>

                <div className="mt-6 space-y-3">
                  {PATH_ORDER.map((id) => {
                    const meta = PATH_META[id];
                    const bullets =
                      id === "fresh"
                        ? ["Clean chart of accounts", "Add records as you go", "Nothing to prepare beforehand"]
                        : id === "import"
                          ? ["Bring customers and products", "We map your columns for you", "Duplicates are skipped"]
                          : ["Bank accounts and statements", "Keep records where they are", "CSV if a connector isn't ready"];
                    return (
                      <ChoiceCard
                        key={id}
                        selected={path === id}
                        onSelect={() => setPath(id)}
                        icon={
                          id === "fresh" ? (
                            <IconSparkle className="size-5" />
                          ) : id === "import" ? (
                            <IconFileText className="size-5" />
                          ) : (
                            <IconLink className="size-5" />
                          )
                        }
                        title={meta.title}
                        blurb={meta.blurb}
                        bullets={bullets}
                        meta={meta.estimate}
                      />
                    );
                  })}
                </div>

                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={!path}
                    onClick={() => setScreen("profile")}
                    className={cn(primaryButtonClass, "w-auto px-5")}
                  >
                    Continue
                    <IconArrowRight className="size-4" />
                  </button>
                </div>
              </div>
            )}

            {screen === "profile" && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setScreen("path")}
                  disabled={creating}
                  className={cn(ghostButtonClass, "mb-3 -ml-2")}
                >
                  <IconChevronLeft className="size-3.5" />
                  Back
                </button>
                <h1 className="text-[26px] leading-tight font-bold tracking-tight">Tell us about your business</h1>
                <p className="mt-1.5 text-sm text-ink-muted">
                  Two fields, then we open your books. You can refine everything afterwards.
                </p>

                <div className="mt-6 space-y-5">
                  <div>
                    <label htmlFor="orgName" className="mb-1.5 block text-[13px] leading-none font-medium text-ink">
                      Business name
                    </label>
                    <input
                      id="orgName"
                      value={orgName}
                      onChange={(e) => setOrgName(e.target.value)}
                      placeholder="Glow Works Ltd"
                      className={inputClass}
                    />
                    <p className="mt-1.5 text-[12px] text-ink-muted">
                      This is how your workspace appears everywhere. It&apos;s easy to rename later.
                    </p>
                  </div>

                  <div>
                    <label htmlFor="currency" className="mb-1.5 block text-[13px] leading-none font-medium text-ink">
                      Currency your books are kept in
                    </label>
                    <select
                      id="currency"
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                      className={inputClass}
                    >
                      {CURRENCIES.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.code} — {c.label}
                        </option>
                      ))}
                      <option value="other">Other (ISO code)</option>
                    </select>
                    {currency === "other" && (
                      <input
                        value={customCurrency}
                        onChange={(e) => setCustomCurrency(e.target.value.toUpperCase())}
                        placeholder="e.g. NGN"
                        maxLength={3}
                        className={cn(inputClass, "mt-2")}
                        aria-label="Currency ISO code"
                      />
                    )}
                    <p className="mt-1.5 text-[12px] text-ink-muted">
                      Chosen once because every amount is stored as whole minor units. It can only be
                      changed by opening a new set of books.
                    </p>
                  </div>

                  <div>
                    <label htmlFor="description" className="mb-1.5 block text-[13px] leading-none font-medium text-ink">
                      What does your business do?
                    </label>
                    <textarea
                      id="description"
                      rows={7}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="We design and sell handmade lighting fixtures online and to interior designers. Most customers order 10–50 units at a time. We offer 2% off to returning wholesale buyers…"
                      className="w-full resize-none rounded-lg border border-sand-300 bg-white px-3 py-2.5 text-sm leading-relaxed text-ink transition-colors outline-none placeholder:text-ink-muted/55 focus:border-gold-500 focus:ring-[3px] focus:ring-gold-500/20"
                    />
                    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[12px]">
                      <span className="text-ink-muted">
                        Who are your customers? How do you make money? Anything special about terms?
                      </span>
                      <span className={descriptionReady ? "text-gold-700" : "text-ink-muted/70"}>
                        {description.trim().length}/{MIN_DESCRIPTION} characters minimum
                      </span>
                    </div>

                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {DESCRIPTION_STARTERS.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setDescription((d) => (d ? d : s))}
                          className="cursor-pointer rounded-full border border-sand-300 bg-sand-50 px-2.5 py-1 text-[12px] text-ink-muted transition-colors hover:border-gold-400 hover:text-ink"
                        >
                          {s.trim()}…
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-6">
                  <button
                    type="button"
                    disabled={creating || !isProfileReady(orgName, description, resolvedCurrency)}
                    onClick={() => void createWorkspace()}
                    className={primaryButtonClass}
                  >
                    {!creating && "Open my books"}
                    {!creating && <IconArrowRight className="size-4" />}
                  </button>
                  {!descriptionReady && (
                    <p className="mt-2 text-[12px] text-ink-muted">
                      Add {MIN_DESCRIPTION - description.trim().length} more characters about what you do to continue.
                    </p>
                  )}
                </div>

                {/* Creation overlay: the wait is real, so show it working. */}
                {creating && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-xl bg-cream/95 backdrop-blur-sm">
                    <Spinner className="size-7 text-gold-600" />
                    <p className="mt-4 text-[15px] font-semibold text-ink" aria-live="polite">
                      {CREATE_PROGRESS[progressStep]}
                    </p>
                    <div className="mt-4 h-1 w-56 overflow-hidden rounded-full bg-sand-200">
                      <div
                        className="h-full rounded-full bg-gold-500 transition-all duration-[2400ms] ease-out"
                        style={{ width: `${((progressStep + 1) / CREATE_PROGRESS.length) * 100}%` }}
                      />
                    </div>
                    <p className="mt-3 max-w-xs text-center text-[12px] text-ink-muted">
                      This only happens once.
                    </p>
                  </div>
                )}
              </div>
            )}

            {screen === "data" && (
              <div>
                {path === "import" ? (
                  <>
                    <h1 className="text-[26px] leading-tight font-bold tracking-tight">Bring your records over</h1>
                    <p className="mt-1.5 text-sm text-ink-muted">
                      Start with whichever spreadsheet you have handy. You can do the other one after setup.
                    </p>
                    <div className="mt-6">
                      <CsvImportPanel
                        onImported={(o) => {
                          setImported((prev) => ({ ...prev, [o.entity]: prev[o.entity] + o.inserted }));
                          void markStep(o.entity === "customers" ? "import_customers" : "import_products", "done");
                        }}
                        onSkipped={() => {
                          void markStep("import_customers", "skipped");
                          void markStep("import_products", "skipped");
                          setScreen("team");
                        }}
                      />
                    </div>
                    <div className="mt-7 flex flex-wrap items-center gap-3 border-t border-sand-200 pt-5">
                      <button
                        type="button"
                        onClick={() => {
                          // Leaving without importing is a real choice, so it is
                          // recorded as one — the checklist will offer it again.
                          if (imported.customers === 0) void markStep("import_customers", "skipped");
                          if (imported.products === 0) void markStep("import_products", "skipped");
                          setScreen("team");
                        }}
                        className={cn(primaryButtonClass, "w-auto px-5")}
                      >
                        {imported.customers + imported.products > 0 ? "Continue" : "Continue without importing"}
                        <IconArrowRight className="size-4" />
                      </button>
                    </div>
                  </>
                ) : connectMode === "csv" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setConnectMode("choose")}
                      className={cn(ghostButtonClass, "mb-3 -ml-2")}
                    >
                      <IconChevronLeft className="size-3.5" />
                      Back to connections
                    </button>
                    <h1 className="text-[26px] leading-tight font-bold tracking-tight">Import a file instead</h1>
                    <p className="mt-1.5 text-sm text-ink-muted">
                      Most systems let you export a CSV, even when there isn&apos;t a direct connector yet.
                    </p>
                    <div className="mt-6">
                      <CsvImportPanel
                        onImported={(o) => {
                          setImported((prev) => ({ ...prev, [o.entity]: prev[o.entity] + o.inserted }));
                          void markStep(o.entity === "customers" ? "import_customers" : "import_products", "done");
                        }}
                        onSkipped={() => setScreen("team")}
                      />
                    </div>
                    <div className="mt-7 border-t border-sand-200 pt-5">
                      <button
                        type="button"
                        onClick={() => setScreen("team")}
                        className={cn(primaryButtonClass, "w-auto px-5")}
                      >
                        Continue
                        <IconArrowRight className="size-4" />
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h1 className="text-[26px] leading-tight font-bold tracking-tight">Connect your data</h1>
                    <p className="mt-1.5 text-sm text-ink-muted">
                      Here is exactly what works today, and what doesn&apos;t yet.
                    </p>

                    <div className="mt-6 space-y-3">
                      <div className="rounded-xl bg-sand-50 p-5 ring-1 ring-sand-200">
                        <div className="flex items-start gap-3.5">
                          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-gold-500/12 text-gold-600">
                            <IconCash className="size-5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-[15px] font-semibold text-ink">Bank accounts and statements</p>
                            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                              Live now. Add a bank account and import a statement, then match the lines
                              against your invoices.
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Link
                                href="/accounting"
                                className={cn(primaryButtonClass, "h-9 w-auto px-3.5 text-[13px]")}
                              >
                                Open the Bank tab
                              </Link>
                              <button
                                type="button"
                                onClick={() => {
                                  void markStep("connect_source", "done");
                                  setConnectNote("Marked as connected. You can add more accounts any time from Accounting.");
                                }}
                                className={cn(secondaryButtonClass, "h-9 text-[13px]")}
                              >
                                I&apos;ve done this
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl bg-sand-50 p-5 ring-1 ring-sand-200">
                        <div className="flex items-start gap-3.5">
                          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-sand-200 text-ink-muted">
                            <IconStore className="size-5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-[15px] font-semibold text-ink">
                              Stores, accounting tools, databases
                            </p>
                            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
                              Not built yet. Rather than offer a button that quietly does nothing, we
                              leave this off your plate and remind you when it lands.
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => setConnectMode("csv")}
                                className={cn(primaryButtonClass, "h-9 w-auto px-3.5 text-[13px]")}
                              >
                                Export a CSV instead
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  void markStep("connect_source", "pending");
                                  setConnectNote("Saved to your setup checklist — we'll surface it on your dashboard.");
                                }}
                                className={cn(secondaryButtonClass, "h-9 text-[13px]")}
                              >
                                Remind me later
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {connectNote && (
                      <p className="mt-4 flex items-start gap-2 rounded-lg bg-gold-500/8 px-3.5 py-2.5 text-[13px] text-ink">
                        <IconCheck className="mt-0.5 size-4 shrink-0 text-gold-600" />
                        {connectNote}
                      </p>
                    )}

                    <div className="mt-7 flex flex-wrap items-center gap-3 border-t border-sand-200 pt-5">
                      <button
                        type="button"
                        onClick={() => setScreen("team")}
                        className={cn(primaryButtonClass, "w-auto px-5")}
                      >
                        Continue
                        <IconArrowRight className="size-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void markStep("connect_source", "skipped");
                          setScreen("team");
                        }}
                        className={ghostButtonClass}
                      >
                        Skip connecting for now
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {screen === "team" && (
              <div>
                <h1 className="text-[26px] leading-tight font-bold tracking-tight">Who else works here?</h1>
                <p className="mt-1.5 text-sm text-ink-muted">
                  Optional. You can do this any time from the Team page — nothing else waits on it.
                </p>

                {rolesFailed ? (
                  <div className="mt-5">
                    <RecoverBlock title="We couldn't load your roles">
                      Roles are created with your workspace, so this is usually a hiccup. You can invite
                      people from the Team page instead — it&apos;s the same thing.
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Link href="/team" className={cn(primaryButtonClass, "h-9 w-auto px-3.5 text-[13px]")}>
                          Go to the Team page
                        </Link>
                        <button
                          type="button"
                          onClick={() => {
                            void markStep("invite_team", "pending");
                            setScreen("done");
                          }}
                          className={cn(secondaryButtonClass, "h-9 text-[13px]")}
                        >
                          Remind me later
                        </button>
                      </div>
                    </RecoverBlock>
                  </div>
                ) : (
                  <div className="mt-6 space-y-3">
                    {invites.map((inv, i) => (
                      <div key={i} className="flex flex-wrap items-start gap-2">
                        <div className="min-w-[12rem] flex-1">
                          <label htmlFor={`invite-email-${i}`} className="sr-only">
                            Email address
                          </label>
                          <input
                            id={`invite-email-${i}`}
                            type="email"
                            value={inv.email}
                            onChange={(e) =>
                              setInvites((prev) => prev.map((p, j) => (j === i ? { ...p, email: e.target.value } : p)))
                            }
                            placeholder="colleague@company.com"
                            className={inputClass}
                          />
                        </div>
                        <div className="w-44">
                          <label htmlFor={`invite-role-${i}`} className="sr-only">
                            Role
                          </label>
                          <select
                            id={`invite-role-${i}`}
                            value={inv.roleId}
                            onChange={(e) =>
                              setInvites((prev) => prev.map((p, j) => (j === i ? { ...p, roleId: e.target.value } : p)))
                            }
                            className={inputClass}
                          >
                            <option value="">Role…</option>
                            {roles.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        {invites.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setInvites((prev) => prev.filter((_, j) => j !== i))}
                            aria-label="Remove this invite"
                            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-sand-100 hover:text-ink"
                          >
                            <IconTrash className="size-4" />
                          </button>
                        )}
                      </div>
                    ))}

                    <button
                      type="button"
                      onClick={() => setInvites((prev) => [...prev, { email: "", roleId: "" }])}
                      className={ghostButtonClass}
                    >
                      + Add another
                    </button>
                  </div>
                )}

                {inviteOutcomes.length > 0 && (
                  <ul className="mt-4 space-y-1.5">
                    {inviteOutcomes.map((o) => (
                      <li
                        key={o.email}
                        className={cn(
                          "flex items-start gap-2 rounded-lg px-3.5 py-2.5 text-[13px]",
                          o.ok ? "bg-gold-500/8 text-ink" : "bg-red-50 text-red-800",
                        )}
                      >
                        {o.ok ? (
                          <IconCheck className="mt-0.5 size-4 shrink-0 text-gold-600" />
                        ) : (
                          <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
                        )}
                        <span>
                          <strong className="font-semibold">{o.email}</strong> — {o.note}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-7 flex flex-wrap items-center gap-3 border-t border-sand-200 pt-5">
                  <button
                    type="button"
                    onClick={() => {
                      if (!inviteOutcomes.some((o) => o.ok)) void markStep("invite_team", "skipped");
                      setScreen("done");
                    }}
                    className={cn(primaryButtonClass, "w-auto px-5")}
                  >
                    {inviteOutcomes.some((o) => o.ok) ? "Continue" : "Skip for now"}
                    <IconArrowRight className="size-4" />
                  </button>
                  {!rolesFailed && (
                    <button
                      type="button"
                      disabled={inviting}
                      onClick={() => void sendInvites()}
                      className={secondaryButtonClass}
                    >
                      {inviting && <Spinner />}
                      {inviting ? "Sending…" : "Send invites"}
                    </button>
                  )}
                </div>
              </div>
            )}

            {screen === "done" && (
              <div>
                <span className="flex size-12 items-center justify-center rounded-full bg-gold-500/12 text-gold-600">
                  <IconCheck className="size-6" />
                </span>
                <h1 className="mt-4 text-[26px] leading-tight font-bold tracking-tight">
                  {orgName.trim()} is ready
                </h1>
                <p className="mt-1.5 text-sm text-ink-muted">
                  Your books are open, balanced at zero, and your AI workmate has read what you told it.
                </p>

                <ul className="mt-6 space-y-2.5">
                  {[
                    { icon: <IconLandmark className="size-4" />, text: "A full chart of accounts, seeded." },
                    { icon: <IconBuilding className="size-4" />, text: `Books kept in ${resolvedCurrency}.` },
                    { icon: <IconShieldCheck className="size-4" />, text: "You are the owner — every gated action waits for you." },
                    ...(imported.customers > 0
                      ? [{ icon: <IconUsers className="size-4" />, text: `${imported.customers.toLocaleString()} customers imported.` }]
                      : []),
                    ...(imported.products > 0
                      ? [{ icon: <IconBox className="size-4" />, text: `${imported.products.toLocaleString()} products imported.` }]
                      : []),
                  ].map((row, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-[14px] text-ink">
                      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-gold-500/12 text-gold-600">
                        {row.icon}
                      </span>
                      {row.text}
                    </li>
                  ))}
                </ul>

                {deferred.length > 0 && (
                  <div className="mt-6 rounded-lg bg-sand-50 p-4 ring-1 ring-sand-200">
                    <p className="text-[13px] font-semibold text-ink">Still on your list</p>
                    <ul className="mt-2.5 space-y-2">
                      {deferred.map((k) => (
                        <li key={k} className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[13px] text-ink-muted">{STEP_META[k].title}</span>
                          <Link
                            href={STEP_META[k].fix.href}
                            className="text-[13px] font-medium text-gold-700 underline-offset-2 hover:underline"
                          >
                            {STEP_META[k].fix.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 text-[12px] text-ink-muted">
                      These stay on your dashboard until you do them or dismiss them.
                    </p>
                  </div>
                )}

                <div className="mt-7">
                  <button type="button" onClick={() => void finish()} disabled={finishing} className={primaryButtonClass}>
                    {finishing && <Spinner />}
                    {finishing ? "Opening your workspace…" : "Go to my workspace"}
                    {!finishing && <IconArrowRight className="size-4" />}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* ── Context column ──────────────────────────────────────────── */}
          <aside className="rounded-xl bg-sand-100 p-6 ring-1 ring-sand-200 lg:sticky lg:top-20">
            <p className="text-[11px] font-bold tracking-[0.1em] text-gold-600 uppercase">{aside.eyebrow}</p>
            <h2 className="mt-2 text-[19px] leading-snug font-semibold text-ink">{aside.title}</h2>
            <p className="mt-2.5 text-[13px] leading-relaxed text-ink-muted">{aside.body}</p>
            <ul className="mt-5 space-y-3">
              {aside.points.map((p, i) => (
                <li key={i} className="flex items-start gap-2.5 text-[13px] text-ink-muted">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-cream text-gold-600 ring-1 ring-sand-200">
                    {p.icon}
                  </span>
                  {p.text}
                </li>
              ))}
            </ul>

            <div className="mt-6 border-t border-sand-200 pt-4">
              <p className="text-[12px] leading-relaxed text-ink-muted">
                Stuck? Everything on the left is optional except the business name and description.
                You can leave and come back — your progress is saved.
              </p>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
