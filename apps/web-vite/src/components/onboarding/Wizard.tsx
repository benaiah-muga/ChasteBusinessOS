import { useEffect, useMemo, useState } from "react";
import {
  completeOnboardingSetup,
  createWorkspace,
  failureOf,
  markOnboardingStep,
  recoveryFor,
  type OnboardingFailure,
  type OnboardingPath,
  type OnboardingStepKey,
  type OnboardingStepStatus,
} from "../../api/onboarding";
import { fetchTeam, submitTeamAction } from "../../api/team";
import { navigate } from "../../navigation";
import { CsvImportPanel } from "./CsvImport";
import {
  ChoiceCard,
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
  OnboardingHeader,
  ProgressBar,
  RecoverBlock,
  Spinner,
  StepRail,
  disabledButton,
  ghostButton,
  gold,
  hairline,
  ink,
  muted,
  primaryButton,
  secondaryButton,
  styles,
  textInput,
  withStyle,
} from "./parts";

/**
 * Setup wizard.
 *
 * Three rules drove this:
 *  1. A new user should never have to guess what a step wants or why it exists.
 *  2. Every failure says what happened and offers the way out, as a button.
 *  3. Anything skippable is *remembered*, not dropped: deferred steps come
 *     back as a checklist on the dashboard.
 *
 * The plan and the decision rules live in this file because the Vite port owns
 * no other module for them, and they exist only to drive this screen.
 */

export const CURRENCIES = [
  { code: "USD", label: "US dollar" },
  { code: "KES", label: "Kenyan shilling" },
  { code: "EUR", label: "Euro" },
  { code: "GBP", label: "Pound sterling" },
  { code: "TZS", label: "Tanzanian shilling" },
  { code: "UGX", label: "Ugandan shilling" },
] as const;

export const PATH_ORDER: OnboardingPath[] = ["fresh", "import", "connect"];

export const PATH_META: Record<OnboardingPath, { title: string; blurb: string; steps: OnboardingStepKey[]; estimate: string }> = {
  fresh: {
    title: "Start from scratch",
    blurb: "Open a clean set of books. Add customers and products as you go.",
    steps: [],
    estimate: "About 2 minutes",
  },
  import: {
    title: "Import a spreadsheet",
    blurb: "You already keep customers or products in a CSV or Excel file.",
    steps: ["import_customers", "import_products"],
    estimate: "About 5 minutes",
  },
  connect: {
    title: "Connect where your data lives",
    blurb: "Your records sit in another system: a store, an accounting tool, a database.",
    steps: ["connect_source"],
    estimate: "Varies",
  },
};

export const STEP_META: Record<OnboardingStepKey, { title: string; why: string; fix: { label: string; href: string } }> = {
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

export type Screen = "path" | "profile" | "data" | "team" | "done";

/** Shortest business description we accept: long enough to be useful to the agent. */
export const MIN_DESCRIPTION = 20;

/**
 * The screens a path walks through. "Start from scratch" has nothing to
 * import, so it skips the data screen entirely; every other path, including no
 * choice yet, keeps it.
 */
export function screensForPath(path: OnboardingPath | null): Screen[] {
  return path === "fresh" ? ["path", "profile", "team", "done"] : ["path", "profile", "data", "team", "done"];
}

/** The rail shows progress, so the terminal screen is not one of the steps. */
export function railScreens(screens: Screen[]): Screen[] {
  return screens.filter((screen) => screen !== "done");
}

/** "Other" currencies arrive as free text and are normalised to ISO uppercase. */
export function resolveBaseCurrency(currency: string, customCurrency: string): string {
  return currency === "other" ? customCurrency.trim().toUpperCase() : currency;
}

export function isDescriptionReady(description: string): boolean {
  return description.trim().length >= MIN_DESCRIPTION;
}

function isOrgNameReady(orgName: string): boolean {
  return orgName.trim().length >= 2;
}

/** Currency is chosen once and stored as integer minor units, so it must be a real ISO code. */
function isCurrencyReady(resolvedCurrency: string): boolean {
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
export function deferredSteps(stepStatus: Partial<Record<OnboardingStepKey, OnboardingStepStatus>>): OnboardingStepKey[] {
  return (Object.keys(stepStatus) as OnboardingStepKey[]).filter(
    (key) => stepStatus[key] === "pending" || stepStatus[key] === "skipped",
  );
}

interface Invite {
  email: string;
  roleId: string;
}

export function readyInvites(invites: Invite[]): Invite[] {
  return invites.filter((invite) => /.+@.+\..+/.test(invite.email.trim()) && Boolean(invite.roleId));
}

const CREATE_PROGRESS = [
  "Reading your description…",
  "Seeding your chart of accounts…",
  "Opening your books, balanced at zero…",
  "Handing you the owner keys…",
];

const DESCRIPTION_STARTERS = ["We sell ", "We manufacture ", "We install and service ", "We run a "];

const BOOTSTRAP_INTENT_KEY = "chaste:onboarding-intent";

/**
 * One bootstrap intent per setup attempt (B01/T08): the id is created once and
 * persisted until the workspace exists, so a retry after a lost response
 * replays the server's receipt instead of creating a second org.
 */
function bootstrapIntentId(): string {
  try {
    const existing = window.localStorage.getItem(BOOTSTRAP_INTENT_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    window.localStorage.setItem(BOOTSTRAP_INTENT_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function clearBootstrapIntent(): void {
  try {
    window.localStorage.removeItem(BOOTSTRAP_INTENT_KEY);
  } catch {
    // Private mode: the in-flight identity still covers this page's retries.
  }
}

const PATH_BULLETS: Record<OnboardingPath, string[]> = {
  fresh: ["Clean chart of accounts", "Add records as you go", "Nothing to prepare beforehand"],
  import: ["Bring customers and products", "We map your columns for you", "Duplicates are skipped"],
  connect: ["Bank accounts and statements", "Keep records where they are", "CSV if a connector isn't ready"],
};

export function OnboardingWizard({ email }: { email: string }) {
  const [screen, setScreen] = useState<Screen>("path");
  const [path, setPath] = useState<OnboardingPath | null>(null);

  const [orgName, setOrgName] = useState("");
  const [currency, setCurrency] = useState<string>("USD");
  const [customCurrency, setCustomCurrency] = useState("");
  const [description, setDescription] = useState("");

  const [creating, setCreating] = useState(false);
  const [progressStep, setProgressStep] = useState(0);
  const [failure, setFailure] = useState<OnboardingFailure | null>(null);

  const [stepStatus, setStepStatus] = useState<Partial<Record<OnboardingStepKey, OnboardingStepStatus>>>({});
  const [imported, setImported] = useState<{ customers: number; products: number }>({ customers: 0, products: 0 });

  const [connectMode, setConnectMode] = useState<"choose" | "csv">("choose");
  const [connectNote, setConnectNote] = useState<string | null>(null);

  const [invites, setInvites] = useState<Invite[]>([{ email: "", roleId: "" }]);
  const [roles, setRoles] = useState<{ id: string; name: string; isSystem: boolean }[]>([]);
  const [rolesFailed, setRolesFailed] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteOutcomes, setInviteOutcomes] = useState<{ email: string; ok: boolean; note: string }[]>([]);

  const [finishing, setFinishing] = useState(false);

  // Cycle the progress copy while the org is being created. Seeding accounts
  // and embedding the profile takes a few seconds; a motionless button reads
  // as a hang.
  useEffect(() => {
    if (!creating) return;
    setProgressStep(0);
    const id = setInterval(() => setProgressStep((step) => Math.min(step + 1, CREATE_PROGRESS.length - 1)), 2400);
    return () => clearInterval(id);
  }, [creating]);

  // Load roles once the workspace exists, so the invite step offers real ones.
  useEffect(() => {
    if (screen !== "team" || roles.length > 0) return;
    const controller = new AbortController();
    void fetchTeam(controller.signal)
      .then((team) => {
        if (controller.signal.aborted) return;
        setRoles(team.roles.map((role) => ({ id: role.id, name: role.name, isSystem: role.isSystem })));
      })
      .catch(() => {
        if (!controller.signal.aborted) setRolesFailed(true);
      });
    return () => controller.abort();
  }, [screen, roles.length]);

  const screens = useMemo<Screen[]>(() => screensForPath(path), [path]);
  const screenIndex = screens.indexOf(screen);
  const rail = railScreens(screens).map((entry) => ({
    key: entry,
    label: entry === "path" ? "How you'll start" : entry === "profile" ? "Your business" : entry === "data" ? "Your data" : "Your team",
  }));

  const setupPercent =
    screen === "done"
      ? 100
      : creating
        ? ((progressStep + 1) / CREATE_PROGRESS.length) * 100
        : Math.max(0, Math.round((Math.max(screenIndex, 0) / Math.max(screens.length - 1, 1)) * 100));
  const createProgressLabel = CREATE_PROGRESS[progressStep] ?? CREATE_PROGRESS[0] ?? "Opening your workspace…";
  const progressLabel = creating
    ? createProgressLabel
    : screen === "done"
      ? "Open your workspace"
      : screen === "path"
        ? "Choose your starting point"
        : screen === "profile"
          ? "Shape your business workspace"
          : screen === "data"
            ? "Bring your records with you"
            : "Make room for your team";
  const progressStatus = creating ? "Opening your books" : screen === "done" ? "Setup complete" : `Step ${Math.max(screenIndex + 1, 1)} of ${screens.length - 1}`;

  const resolvedCurrency = resolveBaseCurrency(currency, customCurrency);
  const descriptionReady = isDescriptionReady(description);
  const deferred = deferredSteps(stepStatus);

  async function markStep(key: OnboardingStepKey, status: OnboardingStepStatus) {
    setStepStatus((previous) => ({ ...previous, [key]: status }));
    try {
      await markOnboardingStep(key, status);
    } catch (error) {
      // The step is still marked locally; a failed write only means the
      // checklist may offer it again, which is the safe direction to fail in.
      console.warn("onboarding step not persisted", failureOf(error));
    }
  }

  async function createWorkspaceNow() {
    setCreating(true);
    setFailure(null);
    try {
      await createWorkspace({
        orgName: orgName.trim(),
        businessDescription: description.trim(),
        baseCurrency: resolvedCurrency,
        path: path ?? "fresh",
        deferredSteps: path ? PATH_META[path].steps : [],
        intentId: bootstrapIntentId(),
      });
    } catch (error) {
      setFailure(failureOf(error));
      return;
    } finally {
      setCreating(false);
    }
    clearBootstrapIntent();
    await markStep("business_profile", "done");
    setScreen(path === "fresh" ? "team" : "data");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function finish() {
    setFinishing(true);
    try {
      await completeOnboardingSetup();
    } catch (error) {
      // Leaving setup open is the safe direction: the checklist simply stays
      // on the dashboard instead of disappearing without finishing.
      console.warn("onboarding completion not persisted", failureOf(error));
    } finally {
      setFinishing(false);
    }
    navigate("/", true);
  }

  async function sendInvites() {
    const valid = readyInvites(invites);
    if (valid.length === 0) return;
    setInviting(true);
    setInviteOutcomes([]);
    const outcomes: { email: string; ok: boolean; note: string }[] = [];
    for (const invite of valid) {
      try {
        const result = await submitTeamAction({ action: "invite", email: invite.email.trim(), roleId: invite.roleId });
        outcomes.push({
          email: invite.email,
          ok: true,
          note: result.kind === "pending"
            ? "Queued for approval, so it lands in the Approvals inbox first."
            : "Invited.",
        });
      } catch (error) {
        outcomes.push({ email: invite.email, ok: false, note: failureOf(error).hint });
      }
    }
    setInviteOutcomes(outcomes);
    setInviting(false);
    if (outcomes.some((outcome) => outcome.ok)) await markStep("invite_team", "done");
  }

  const recovery = failure ? recoveryFor(failure.code) : "none";
  const pendingApproval = failure?.code === "pending_approval";

  const failureActions = failure && !pendingApproval ? (
    <>
      {recovery === "signin" && (
        <a href="/login" style={withStyle(primaryButton, { minHeight: 36, fontSize: 12, textDecoration: "none" })}>
          Sign in again
        </a>
      )}
      {recovery === "dashboard" && (
        <a href="/" style={withStyle(primaryButton, { minHeight: 36, fontSize: 12, textDecoration: "none" })}>
          Open my dashboard
        </a>
      )}
      {recovery === "retry" && (
        <button
          type="button"
          onClick={() => {
            setFailure(null);
            if (screen === "profile") void createWorkspaceNow();
          }}
          style={withStyle(primaryButton, { minHeight: 36, fontSize: 12 })}
        >
          Try again
        </button>
      )}
    </>
  ) : undefined;

  /* ── Right-hand column: what this step does and why it is safe ────────── */

  const aside = (() => {
    switch (screen) {
      case "path":
        return {
          eyebrow: `Step 1 of ${screens.length - 1}`,
          title: "Nothing here is locked in",
          body: "Pick the closest match. Every one of these can be done later, changed, or done twice: the books do not care which door you came in by.",
          points: [
            { icon: <IconLandmark style={styles.pointChip} />, text: "Your chart of accounts is seeded either way." },
            { icon: <IconShieldCheck style={styles.pointChip} />, text: "You stay the owner, whatever you choose." },
          ],
        };
      case "profile":
        return {
          eyebrow: `Step 2 of ${screens.length - 1}`,
          title: "Why we ask for a paragraph",
          body: "This is the only time the platform asks you to explain your business in prose. Describe it the way you would to a new bookkeeper.",
          points: [
            { icon: <IconSparkle style={styles.pointChip} />, text: "Your AI workmate reads it once and remembers it." },
            { icon: <IconLandmark style={styles.pointChip} />, text: "A standard chart of accounts is created and balanced at zero." },
            { icon: <IconShieldCheck style={styles.pointChip} />, text: "You become the owner, with authority over every gated action." },
          ],
        };
      case "data":
        return path === "import"
          ? {
              eyebrow: `Step 3 of ${screens.length - 1}`,
              title: "Your file stays yours",
              body: "We read the file in your browser first and show you exactly what will land before anything is written. Duplicate customers are skipped, not duplicated.",
              points: [
                { icon: <IconCheck style={styles.pointChip} />, text: "One bad row never cancels the whole import." },
                { icon: <IconFileText style={styles.pointChip} />, text: "Anything unmatched is listed by row number." },
              ],
            }
          : {
              eyebrow: `Step 3 of ${screens.length - 1}`,
              title: "About connections",
              body: "Some connections are live today, others are still being built. We would rather tell you which is which than offer a button that does nothing.",
              points: [
                { icon: <IconCash style={styles.pointChip} />, text: "Bank accounts and statement imports are live." },
                { icon: <IconStore style={styles.pointChip} />, text: "Store and accounting connectors are still on the way." },
              ],
            };
      case "team":
        return {
          eyebrow: `Step ${screenIndex + 1} of ${screens.length - 1}`,
          title: "Why identities matter here",
          body: "Everyone acts under their own name, so the audit trail can always answer who did what, including the AI. That is the whole point of the system.",
          points: [
            { icon: <IconUsers style={styles.pointChip} />, text: "Invites carry a role, and roles carry authority." },
            { icon: <IconBookOpen style={styles.pointChip} />, text: "Every action is hash-chained to a person or an agent." },
          ],
        };
      default:
        return {
          eyebrow: "All done",
          title: "Your books are open",
          body: "You can change anything you set up here, at any time, from Settings.",
          points: [
            { icon: <IconLandmark style={styles.pointChip} />, text: "Chart of accounts seeded, balanced at zero." },
            { icon: <IconShieldCheck style={styles.pointChip} />, text: "You are the owner. Nothing acts without your say." },
          ],
        };
    }
  })();

  return (
    <div style={styles.page}>
      <OnboardingHeader email={email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <StepRail steps={rail} current={Math.min(screenIndex, rail.length - 1)} />
          <ProgressBar value={setupPercent} label={progressLabel} status={progressStatus} />
        </div>

        <div style={styles.columns}>
          {/* ── The step ───────────────────────────────────────────────── */}
          <section style={styles.card}>
            {failure && (
              <div style={{ marginBottom: 18 }}>
                <RecoverBlock title={failure.title} tone={pendingApproval ? "warn" : "error"} actions={failureActions}>
                  {failure.hint}
                </RecoverBlock>
              </div>
            )}

            {screen === "path" && (
              <div style={styles.stack}>
                <div>
                  <h1 style={styles.title}>How would you like to start?</h1>
                  <p style={styles.lede}>There is no wrong answer: this only decides what we offer you next.</p>
                </div>

                <div style={styles.stackTight}>
                  {PATH_ORDER.map((id) => (
                    <ChoiceCard
                      key={id}
                      selected={path === id}
                      onSelect={() => setPath(id)}
                      icon={
                        id === "fresh" ? (
                          <IconSparkle />
                        ) : id === "import" ? (
                          <IconFileText />
                        ) : (
                          <IconLink />
                        )
                      }
                      title={PATH_META[id].title}
                      blurb={PATH_META[id].blurb}
                      bullets={PATH_BULLETS[id]}
                      meta={PATH_META[id].estimate}
                    />
                  ))}
                </div>

                <div style={styles.row}>
                  <button type="button" disabled={!path} onClick={() => setScreen("profile")} style={withStyle(primaryButton, !path ? disabledButton : undefined)}>
                    Continue
                    <IconArrowRight style={{ fontSize: 14 }} />
                  </button>
                </div>
              </div>
            )}

            {screen === "profile" && (
              <div style={{ ...styles.stack, position: "relative" }}>
                <div>
                  <button type="button" onClick={() => setScreen("path")} disabled={creating} style={withStyle(ghostButton, { marginBottom: 10 })}>
                    <IconChevronLeft style={{ fontSize: 13 }} />
                    Back
                  </button>
                  <h1 style={styles.title}>Tell us about your business</h1>
                  <p style={styles.lede}>Two fields, then we open your books. You can refine everything afterwards.</p>
                </div>

                <div style={styles.stack}>
                  <div style={styles.field}>
                    <label htmlFor="orgName" style={styles.label}>
                      Business name
                    </label>
                    <input
                      id="orgName"
                      value={orgName}
                      onChange={(event) => setOrgName(event.currentTarget.value)}
                      placeholder="Glow Works Ltd"
                      style={textInput}
                    />
                    <span style={styles.note}>This is how your workspace appears everywhere. Renaming it later is easy.</span>
                  </div>

                  <div style={styles.field}>
                    <label htmlFor="currency" style={styles.label}>
                      Currency your books are kept in
                    </label>
                    <select id="currency" value={currency} onChange={(event) => setCurrency(event.currentTarget.value)} style={textInput}>
                      {CURRENCIES.map((option) => (
                        <option key={option.code} value={option.code}>
                          {option.code} - {option.label}
                        </option>
                      ))}
                      <option value="other">Other (ISO code)</option>
                    </select>
                    {currency === "other" && (
                      <input
                        value={customCurrency}
                        onChange={(event) => setCustomCurrency(event.currentTarget.value.toUpperCase())}
                        placeholder="e.g. NGN"
                        maxLength={3}
                        aria-label="Currency ISO code"
                        style={textInput}
                      />
                    )}
                    <span style={styles.note}>
                      Chosen once because every amount is stored as whole minor units. It can only be changed by
                      opening a new set of books.
                    </span>
                  </div>

                  <div style={styles.field}>
                    <label htmlFor="description" style={styles.label}>
                      What does your business do?
                    </label>
                    <textarea
                      id="description"
                      rows={4}
                      value={description}
                      onChange={(event) => setDescription(event.currentTarget.value)}
                      placeholder="We design and sell handmade lighting fixtures online and to interior designers. Most customers order 10 to 50 units at a time. We offer 2% off to returning wholesale buyers…"
                      style={withStyle(textInput, { minHeight: 118, padding: "10px 12px", lineHeight: 1.6, resize: "vertical" })}
                    />
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={styles.note}>
                        Who are your customers? How do you make money? Anything special about terms?
                      </span>
                      <span style={{ ...styles.note, color: descriptionReady ? gold : muted }}>
                        {description.trim().length}/{MIN_DESCRIPTION} characters minimum
                      </span>
                    </div>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                      {DESCRIPTION_STARTERS.map((starter) => (
                        <button
                          key={starter}
                          type="button"
                          onClick={() => setDescription((current) => (current ? current : starter))}
                          style={withStyle(styles.chip, { cursor: "pointer" })}
                        >
                          {starter.trim()}…
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <button
                    type="button"
                    disabled={creating || !isProfileReady(orgName, description, resolvedCurrency)}
                    onClick={() => void createWorkspaceNow()}
                    style={withStyle(primaryButton, creating || !isProfileReady(orgName, description, resolvedCurrency) ? disabledButton : undefined)}
                  >
                    {creating ? "Opening your books…" : "Open my books"}
                    {!creating && <IconArrowRight style={{ fontSize: 14 }} />}
                  </button>
                  {!descriptionReady && (
                    <p style={{ ...styles.note, marginTop: 9 }}>
                      Add {MIN_DESCRIPTION - description.trim().length} more characters about what you do to continue.
                    </p>
                  )}
                </div>

                {/* Creation overlay: the wait is real, so show it working. */}
                {creating && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      zIndex: 10,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 16,
                      borderRadius: 18,
                      background: "rgb(255 254 250 / 96%)",
                      padding: 24,
                    }}
                  >
                    <Spinner size={28} color={gold} />
                    <div style={{ width: "100%", maxWidth: 380 }}>
                      <ProgressBar value={setupPercent} label={progressLabel} status="Opening your workspace" />
                    </div>
                    <p style={{ ...styles.note, textAlign: "center" }}>This only happens once.</p>
                  </div>
                )}
              </div>
            )}

            {screen === "data" && (
              <div style={styles.stack}>
                {path === "import" ? (
                  <>
                    <div>
                      <h1 style={styles.title}>Bring your records over</h1>
                      <p style={styles.lede}>
                        Start with whichever spreadsheet you have handy. You can do the other one after setup.
                      </p>
                    </div>
                    <CsvImportPanel
                      onImported={(outcome) => {
                        setImported((previous) => ({ ...previous, [outcome.entity]: previous[outcome.entity] + outcome.inserted }));
                        void markStep(outcome.entity === "customers" ? "import_customers" : "import_products", "done");
                      }}
                      onSkipped={() => {
                        void markStep("import_customers", "skipped");
                        void markStep("import_products", "skipped");
                        setScreen("team");
                      }}
                    />
                    <div style={{ ...styles.divider, ...styles.row, paddingTop: 20 }}>
                      <button
                        type="button"
                        onClick={() => {
                          // Leaving without importing is a real choice, so it is
                          // recorded as one: the checklist will offer it again.
                          if (imported.customers === 0) void markStep("import_customers", "skipped");
                          if (imported.products === 0) void markStep("import_products", "skipped");
                          setScreen("team");
                        }}
                        style={primaryButton}
                      >
                        {imported.customers + imported.products > 0 ? "Continue" : "Continue without importing"}
                        <IconArrowRight style={{ fontSize: 14 }} />
                      </button>
                    </div>
                  </>
                ) : connectMode === "csv" ? (
                  <>
                    <div>
                      <button type="button" onClick={() => setConnectMode("choose")} style={withStyle(ghostButton, { marginBottom: 10 })}>
                        <IconChevronLeft style={{ fontSize: 13 }} />
                        Back to connections
                      </button>
                      <h1 style={styles.title}>Import a file instead</h1>
                      <p style={styles.lede}>
                        Most systems let you export a CSV, even when there is not a direct connector yet.
                      </p>
                    </div>
                    <CsvImportPanel
                      onImported={(outcome) => {
                        setImported((previous) => ({ ...previous, [outcome.entity]: previous[outcome.entity] + outcome.inserted }));
                        void markStep(outcome.entity === "customers" ? "import_customers" : "import_products", "done");
                      }}
                      onSkipped={() => setScreen("team")}
                    />
                    <div style={{ ...styles.divider, ...styles.row, paddingTop: 20 }}>
                      <button type="button" onClick={() => setScreen("team")} style={primaryButton}>
                        Continue
                        <IconArrowRight style={{ fontSize: 14 }} />
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <h1 style={styles.title}>Connect your data</h1>
                      <p style={styles.lede}>Here is exactly what works today, and what does not yet.</p>
                    </div>

                    <div style={styles.stackTight}>
                      <div style={{ border: `1px solid ${hairline}`, borderRadius: 12, padding: 18, background: "#faf9f4" }}>
                        <p style={{ margin: 0, fontSize: 14.5, fontWeight: 650 }}>Bank accounts and statements</p>
                        <p style={{ ...styles.lede, marginTop: 5 }}>
                          Live now. Add a bank account and import a statement, then match the lines against your
                          invoices.
                        </p>
                        <div style={{ ...styles.row, marginTop: 12 }}>
                          <a href="/accounting" style={withStyle(primaryButton, { minHeight: 36, fontSize: 12, textDecoration: "none" })}>
                            Open the Bank tab
                          </a>
                          <button
                            type="button"
                            onClick={() => {
                              void markStep("connect_source", "done");
                              setConnectNote("Marked as connected. You can add more accounts any time from Accounting.");
                            }}
                            style={withStyle(secondaryButton, { minHeight: 36, fontSize: 12 })}
                          >
                            I&apos;ve done this
                          </button>
                        </div>
                      </div>

                      <div style={{ border: `1px solid ${hairline}`, borderRadius: 12, padding: 18, background: "#faf9f4" }}>
                        <p style={{ margin: 0, fontSize: 14.5, fontWeight: 650 }}>Stores, accounting tools, databases</p>
                        <p style={{ ...styles.lede, marginTop: 5 }}>
                          Not built yet. Rather than offer a button that quietly does nothing, we leave this off
                          your plate and remind you when it lands.
                        </p>
                        <div style={{ ...styles.row, marginTop: 12 }}>
                          <button type="button" onClick={() => setConnectMode("csv")} style={withStyle(primaryButton, { minHeight: 36, fontSize: 12 })}>
                            Export a CSV instead
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void markStep("connect_source", "pending");
                              setConnectNote("Saved to your setup checklist, and we will surface it on your dashboard.");
                            }}
                            style={withStyle(secondaryButton, { minHeight: 36, fontSize: 12 })}
                          >
                            Remind me later
                          </button>
                        </div>
                      </div>
                    </div>

                    {connectNote && (
                      <p style={{ display: "flex", alignItems: "flex-start", gap: 8, borderRadius: 10, padding: "10px 13px", background: "rgb(200 168 102 / 10%)", fontSize: 12.5 }}>
                        <IconCheck style={{ width: 14, height: 14, flex: "0 0 auto", marginTop: 2, color: gold }} />
                        {connectNote}
                      </p>
                    )}

                    <div style={styles.row}>
                      <button type="button" onClick={() => setScreen("team")} style={primaryButton}>
                        Continue
                        <IconArrowRight style={{ fontSize: 14 }} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void markStep("connect_source", "skipped");
                          setScreen("team");
                        }}
                        style={ghostButton}
                      >
                        Skip connecting for now
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {screen === "team" && (
              <div style={styles.stack}>
                <div>
                  <h1 style={styles.title}>Who else works here?</h1>
                  <p style={styles.lede}>
                    Optional. You can do this any time from the Team page, and nothing else waits on it.
                  </p>
                </div>

                {rolesFailed ? (
                  <RecoverBlock
                    title="We couldn't load your roles"
                    actions={
                      <>
                        <a href="/team" style={withStyle(primaryButton, { minHeight: 36, fontSize: 12, textDecoration: "none" })}>
                          Go to the Team page
                        </a>
                        <button
                          type="button"
                          onClick={() => {
                            void markStep("invite_team", "pending");
                            setScreen("done");
                          }}
                          style={withStyle(secondaryButton, { minHeight: 36, fontSize: 12 })}
                        >
                          Remind me later
                        </button>
                      </>
                    }
                  >
                    Roles are created with your workspace, so this is usually a hiccup. You can invite people from
                    the Team page instead: it is the same thing.
                  </RecoverBlock>
                ) : (
                  <div style={styles.stackTight}>
                    {invites.map((invite, index) => (
                      <div key={index} style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 9 }}>
                        <span style={{ minWidth: 200, flex: 1 }}>
                          <label htmlFor={`invite-email-${index}`} className="sr-only">
                            Email address
                          </label>
                          <input
                            id={`invite-email-${index}`}
                            type="email"
                            value={invite.email}
                            onChange={(event) => {
                              // Read the value before dispatch: React clears
                              // currentTarget once the handler returns, and the
                              // updater below runs inside the reducer.
                              const email = event.currentTarget.value;
                              setInvites((previous) =>
                                previous.map((entry, position) => (position === index ? { ...entry, email } : entry)),
                              );
                            }}
                            placeholder="colleague@company.com"
                            style={textInput}
                          />
                        </span>
                        <span style={{ width: 190 }}>
                          <label htmlFor={`invite-role-${index}`} className="sr-only">
                            Role
                          </label>
                          <select
                            id={`invite-role-${index}`}
                            value={invite.roleId}
                            onChange={(event) => {
                              const roleId = event.currentTarget.value;
                              setInvites((previous) =>
                                previous.map((entry, position) => (position === index ? { ...entry, roleId } : entry)),
                              );
                            }}
                            style={textInput}
                          >
                            <option value="">Role…</option>
                            {roles.map((role) => (
                              <option key={role.id} value={role.id}>
                                {role.name}
                              </option>
                            ))}
                          </select>
                        </span>
                        {invites.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setInvites((previous) => previous.filter((_, position) => position !== index))}
                            aria-label="Remove this invite"
                            style={{ ...styles.pointChip, border: 0, cursor: "pointer", height: 42, width: 42, background: "#f1efe7" }}
                          >
                            <IconTrash style={{ fontSize: 15 }} />
                          </button>
                        )}
                      </div>
                    ))}

                    <div>
                      <button
                        type="button"
                        onClick={() => setInvites((previous) => [...previous, { email: "", roleId: "" }])}
                        style={ghostButton}
                      >
                        + Add another
                      </button>
                    </div>
                  </div>
                )}

                {inviteOutcomes.length > 0 && (
                  <ul style={styles.list}>
                    {inviteOutcomes.map((outcome) => (
                      <li
                        key={outcome.email}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 8,
                          borderRadius: 10,
                          padding: "10px 13px",
                          background: outcome.ok ? "rgb(200 168 102 / 10%)" : "rgb(180 72 61 / 7%)",
                          color: outcome.ok ? ink : "#8f302a",
                          fontSize: 12.5,
                        }}
                      >
                        {outcome.ok ? (
                          <IconCheck style={{ width: 14, height: 14, flex: "0 0 auto", marginTop: 2, color: gold }} />
                        ) : (
                          <IconAlertTriangle style={{ width: 14, height: 14, flex: "0 0 auto", marginTop: 2 }} />
                        )}
                        <span>
                          <strong>{outcome.email}</strong> - {outcome.note}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <div style={styles.row}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!inviteOutcomes.some((outcome) => outcome.ok)) void markStep("invite_team", "skipped");
                      setScreen("done");
                    }}
                    style={primaryButton}
                  >
                    {inviteOutcomes.some((outcome) => outcome.ok) ? "Continue" : "Skip for now"}
                    <IconArrowRight style={{ fontSize: 14 }} />
                  </button>
                  {!rolesFailed && (
                    <button type="button" disabled={inviting} onClick={() => void sendInvites()} style={withStyle(secondaryButton, inviting ? disabledButton : undefined)}>
                      {inviting ? <Spinner /> : null}
                      {inviting ? "Sending…" : "Send invites"}
                    </button>
                  )}
                </div>
              </div>
            )}

            {screen === "done" && (
              <div style={styles.stack}>
                <ProgressBar value={100} label="Open your workspace" status="Setup complete" />
                <div>
                  <h1 style={styles.title}>{orgName.trim()} is ready</h1>
                  <p style={styles.lede}>
                    Your books are open, balanced at zero, and your AI workmate has read what you told it.
                  </p>
                </div>

                <ul style={styles.list}>
                  {[
                    { icon: <IconLandmark style={styles.pointChip} />, text: "A full chart of accounts, seeded." },
                    { icon: <IconBuilding style={styles.pointChip} />, text: `Books kept in ${resolvedCurrency}.` },
                    { icon: <IconShieldCheck style={styles.pointChip} />, text: "You are the owner, so every gated action waits for you." },
                    ...(imported.customers > 0
                      ? [{ icon: <IconUsers style={styles.pointChip} />, text: `${imported.customers.toLocaleString()} customers imported.` }]
                      : []),
                    ...(imported.products > 0
                      ? [{ icon: <IconBox style={styles.pointChip} />, text: `${imported.products.toLocaleString()} products imported.` }]
                      : []),
                  ].map((row, index) => (
                    <li key={index} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13.5 }}>
                      {row.icon}
                      {row.text}
                    </li>
                  ))}
                </ul>

                {deferred.length > 0 && (
                  <div style={{ border: `1px solid ${hairline}`, borderRadius: 12, padding: 16, background: "#faf9f4" }}>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 650 }}>Still on your list</p>
                    <ul style={{ ...styles.list, marginTop: 10 }}>
                      {deferred.map((key) => (
                        <li key={key} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <span style={{ color: muted, fontSize: 12.5 }}>{STEP_META[key].title}</span>
                          <a href={STEP_META[key].fix.href} style={styles.link}>
                            {STEP_META[key].fix.label}
                          </a>
                        </li>
                      ))}
                    </ul>
                    <p style={{ ...styles.note, marginTop: 11 }}>
                      These stay on your dashboard until you do them or dismiss them.
                    </p>
                  </div>
                )}

                <div>
                  <button type="button" onClick={() => void finish()} disabled={finishing} style={withStyle(primaryButton, finishing ? disabledButton : undefined)}>
                    {finishing ? <Spinner /> : null}
                    {finishing ? "Opening your workspace…" : "Go to my workspace"}
                    {!finishing && <IconArrowRight style={{ fontSize: 14 }} />}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* ── Context column ──────────────────────────────────────────── */}
          <aside style={styles.aside}>
            <p style={styles.eyebrow}>{aside.eyebrow}</p>
            <h2 style={{ margin: "8px 0 0", fontFamily: 'Georgia, "Times New Roman", serif', fontSize: 18, fontWeight: 500, letterSpacing: "-.02em" }}>
              {aside.title}
            </h2>
            <p style={{ ...styles.lede, marginTop: 9 }}>{aside.body}</p>
            <ul style={{ ...styles.list, marginTop: 16 }}>
              {aside.points.map((point, index) => (
                <li key={index} style={{ display: "flex", alignItems: "flex-start", gap: 10, color: muted, fontSize: 12.5, lineHeight: 1.6 }}>
                  {point.icon}
                  {point.text}
                </li>
              ))}
            </ul>

            <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${hairline}` }}>
              <p style={styles.note}>
                Stuck? Everything on the left is optional except the business name and description. You can leave
                and come back: your progress is saved.
              </p>
            </div>
            {screen !== "done" && (
              <p style={{ ...styles.note, marginTop: 12 }}>
                Everything here can be changed later in{" "}
                <a href="/settings" style={styles.link}>
                  Settings
                </a>
                .
              </p>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}