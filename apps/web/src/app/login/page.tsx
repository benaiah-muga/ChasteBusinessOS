"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createAuthClient } from "better-auth/client";
import { LogoMark } from "@/components/logo";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconArrowsHorizontal,
  IconBookOpen,
  IconEye,
  IconEyeOff,
  IconInbox,
  IconSearch,
  IconShieldCheck,
} from "@/components/icons";

const authClient = createAuthClient();

const VALUE_PROPS = [
  {
    num: "01",
    title: "Governed",
    body: "Every money and identity action waits for your approval. Nothing acts silently.",
    Icon: IconShieldCheck,
  },
  {
    num: "02",
    title: "Auditable",
    body: "A hash-chained event trail records who did what - human or agent - forever.",
    Icon: IconBookOpen,
  },
  {
    num: "03",
    title: "Reversible",
    body: "Double-entry books that cannot lie. Corrections are mirror reversals, never edits.",
    Icon: IconArrowsHorizontal,
  },
];

function Spinner() {
  return (
    <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return <LogoMark size={compact ? 36 : 44} />;
}

function authErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.toLowerCase();
  if (normalized.includes("verif")) {
    // sendOnSignIn fires a fresh link on every unverified sign-in attempt, so
    // the honest answer is "check your inbox", not "wrong password".
    return "That email isn't verified yet. We just sent a fresh link - click it, then sign in.";
  }
  if (normalized.includes("invalid") || normalized.includes("credential") || normalized.includes("password")) {
    return "That email and password did not match. Check them and try again.";
  }
  if (normalized.includes("already") || normalized.includes("exist")) {
    return "An account with that email already exists. Try signing in instead.";
  }
  if (normalized.includes("network") || normalized.includes("fetch")) {
    return "We could not reach Chaste. Check your connection and try again.";
  }
  return raw.length > 0 && raw.length <= 160 ? raw : "We could not complete that request. Try again in a moment.";
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifySent, setVerifySent] = useState(false);

  useEffect(() => {
    let mounted = true;
    void authClient.getSession().then((res) => {
      if (mounted && res.data?.user) router.replace("/");
    });
    return () => {
      mounted = false;
    };
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === "signup"
          ? await authClient.signUp.email({
              email,
              password,
              name: name || (email.split("@")[0] ?? "Founder"),
            })
          : await authClient.signIn.email({ email, password });
      if (res.error) throw new Error(res.error.message ?? "authentication failed");
      if (mode === "signup" && res.data?.token == null) {
        // Verified-binding deployments skip auto sign-in: the account exists
        // but there is no session yet, so success here means "check your
        // inbox", not "come in" - and redirecting would just bounce off the
        // auth guard straight back to this page.
        setVerifySent(true);
        setBusy(false);
        return;
      }
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(authErrorMessage(err));
      setBusy(false);
    }
  }

  function toggleMode() {
    setMode(mode === "signup" ? "signin" : "signup");
    setError(null);
    setVerifySent(false);
  }

  return (
    <div className="min-h-screen bg-[#111416] font-display text-[#f7f1e8]">
      <main className="grid min-h-screen lg:grid-cols-[0.92fr_1.08fr]">
        <section className="relative hidden overflow-hidden bg-[#111416] px-10 py-9 lg:flex lg:flex-col xl:px-16">
          <div className="auth-orbit auth-orbit--one -right-44 top-36" />
          <div className="auth-orbit auth-orbit--two -bottom-10 left-12" />
          <div className="relative z-10 flex items-center gap-3">
            <BrandMark />
            <div>
              <p className="text-[15px] font-semibold tracking-[-0.02em]">Chaste Business OS</p>
              <p className="mt-0.5 text-[10px] tracking-[0.2em] text-[#a9a39b] uppercase">The AI-native business operating system</p>
            </div>
          </div>

          <div className="relative z-10 my-auto max-w-xl py-4">
            <p className="rise text-[11px] font-bold tracking-[0.22em] text-[#d2aa6a] uppercase [--rise-delay:80ms]">Open source · built for everyone</p>
            <h1 className="rise mt-4 max-w-lg text-[clamp(2.25rem,4vw,4.2rem)] leading-[0.98] font-semibold tracking-[-0.075em] text-[#f7f1e8] [--rise-delay:150ms]">
              Run the business.
              <span className="block text-[#cba269]">Keep the authority.</span>
            </h1>
            <p className="rise mt-4 max-w-md text-[14px] leading-6 text-[#bdb8b0] [--rise-delay:220ms]">
              Describe your business. Your AI workmate runs it under your authority, with every action governed, auditable, and reversible.
            </p>
            <div className="rise mt-7 grid max-w-lg grid-cols-3 border-y border-white/10 py-4 [--rise-delay:290ms]">
              {VALUE_PROPS.map(({ num, title, Icon }) => (
                <div key={num} className="border-r border-white/10 pr-4 last:border-0 last:pr-0">
                  <Icon className="size-4 text-[#d2aa6a]" />
                  <p className="mt-3 text-[11px] font-bold tracking-[0.14em] text-[#f7f1e8] uppercase">{title}</p>
                  <p className="mt-1 text-[11px] leading-4 text-[#8f8c87]">{num === "01" ? "Nothing acts silently." : num === "02" ? "Every action leaves a trail." : "Corrections are mirror reversals."}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="relative z-10 flex items-center justify-between text-[10px] tracking-[0.18em] text-[#817d76] uppercase">
            <span>Simple to adopt.</span>
            <span>Powerful to grow.</span>
          </div>
        </section>

        <section className="relative flex min-h-screen items-center overflow-hidden bg-canvas px-5 py-7 text-stone-950 sm:px-8 lg:py-8">
          <div className="absolute -right-40 -top-40 size-[30rem] rounded-full bg-[#d3aa6c]/10 blur-3xl" />
          <div className="relative mx-auto my-auto w-full max-w-[510px]">
            <div className="mb-7 flex items-center justify-between lg:hidden">
              <div className="flex items-center gap-2.5">
                <BrandMark compact />
                <div>
                  <p className="text-sm font-semibold">Chaste Business OS</p>
                  <p className="text-[10px] tracking-[0.15em] text-[#847d72] uppercase">Open source · built for everyone</p>
                </div>
              </div>
              <IconSearch className="size-4 text-[#a9854e]" aria-hidden="true" />
            </div>

            <div className="rise rounded-[1.75rem] border border-stone-300 bg-cream/85 p-6 shadow-[0_28px_80px_rgba(59,46,26,0.12)] backdrop-blur sm:p-9 [--rise-delay:100ms]">
              <div className="flex items-start justify-between gap-5">
                <div>
                  <p className="text-[10px] font-bold tracking-[0.2em] text-gold-700 uppercase">{verifySent ? "One more step" : mode === "signup" ? "Create your workspace" : "Welcome back"}</p>
                  <h2 className="mt-2 text-[2rem] leading-none font-semibold tracking-[-0.06em]">{verifySent ? "Check your inbox." : mode === "signup" ? "Start with clarity." : "Good to see you."}</h2>
                  <p className="mt-3 max-w-sm text-sm leading-6 text-stone-600">
                    {verifySent ? "Confirm your email to open the door." : mode === "signup" ? "Create your workspace to get started." : "Sign in to your workspace."}
                  </p>
                </div>
                <span className="hidden size-9 items-center justify-center rounded-full border border-gold-600/40 bg-gold-500/15 text-xs font-bold text-gold-700 sm:flex">{verifySent ? "✉" : mode === "signup" ? "01" : "↗"}</span>
              </div>

              {verifySent ? (
                <div className="mt-7">
                  <div className="flex items-start gap-3 rounded-xl border border-gold-600/40 bg-gold-500/10 px-4 py-4">
                    <IconInbox className="mt-0.5 size-5 shrink-0 text-gold-700" />
                    <p className="text-sm leading-6 text-stone-800">
                      We sent a verification link to{" "}
                      <strong className="font-semibold text-stone-950">{email.trim()}</strong>. Click it to prove
                      the address is yours - then sign in and we&apos;ll take you straight into setup.
                    </p>
                  </div>
                  <p className="mt-3 text-[12px] leading-5 text-stone-500">
                    No email? Check spam, or try signing in - that sends a fresh link automatically.
                  </p>
                  <button type="button" onClick={toggleMode} className="group mt-4 inline-flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-gold-700 underline-offset-4 hover:underline">
                    <IconArrowRight className="size-4 rotate-180 transition-transform group-hover:-translate-x-0.5" />
                    Back to sign in
                  </button>
                </div>
              ) : (
                <>
              <form onSubmit={submit} className="mt-7 space-y-4">
                {mode === "signup" && (
                  <div>
                    <label htmlFor="name" className="mb-1.5 block text-[12px] font-semibold tracking-[0.04em] text-stone-800">Your name</label>
                    <input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Ada Lovelace" className="h-11 w-full rounded-xl border border-stone-300 bg-white/70 px-3.5 text-sm text-ink transition-colors outline-none placeholder:text-stone-400 focus:border-gold-600 focus:ring-[3px] focus:ring-gold-600/20" />
                  </div>
                )}

                <div>
                  <label htmlFor="email" className="mb-1.5 block text-[12px] font-semibold tracking-[0.04em] text-stone-800">Email</label>
                  <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@company.com" className="h-11 w-full rounded-xl border border-stone-300 bg-white/70 px-3.5 text-sm text-ink transition-colors outline-none placeholder:text-stone-400 focus:border-gold-600 focus:ring-[3px] focus:ring-gold-600/20" />
                </div>

                <div>
                  <label htmlFor="password" className="mb-1.5 block text-[12px] font-semibold tracking-[0.04em] text-stone-800">Password</label>
                  <div className="relative">
                    <input id="password" type={showPassword ? "text" : "password"} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder="At least 8 characters" className="h-11 w-full rounded-xl border border-stone-300 bg-white/70 pr-11 pl-3.5 text-sm text-ink transition-colors outline-none placeholder:text-stone-400 focus:border-gold-600 focus:ring-[3px] focus:ring-gold-600/20" />
                    <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? "Hide password" : "Show password"} className="absolute inset-y-0 right-0 flex w-11 cursor-pointer items-center justify-center rounded-r-xl text-stone-500 transition-colors hover:text-stone-950">
                      {showPassword ? <IconEyeOff className="size-4" /> : <IconEye className="size-4" />}
                    </button>
                  </div>
                </div>

                {error && <p role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-3 text-sm text-red-800 dark:text-red-300"><IconAlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{error}</span></p>}

                <button type="submit" disabled={busy} className="group inline-flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-stone-950 text-sm font-semibold text-cream shadow-[0_12px_26px_rgba(23,26,27,0.18)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-stone-900 focus-visible:ring-[3px] focus-visible:ring-gold-600/35 focus-visible:outline-none active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-55">
                  {busy && <Spinner />}
                  {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
                  {!busy && <span className="text-gold-400 transition-transform group-hover:translate-x-1">→</span>}
                </button>
              </form>

              <p className="mt-6 text-center text-sm text-stone-600">
                {mode === "signup" ? "Already have an account?" : "New to Chaste?"}{" "}
                <button type="button" onClick={toggleMode} className="cursor-pointer font-semibold text-gold-700 underline-offset-4 hover:underline">{mode === "signup" ? "Sign in" : "Create an account"}</button>
              </p>
                </>
              )}
            </div>

            <div className="mt-5 flex items-center justify-center gap-2 text-[10px] tracking-[0.12em] text-stone-500 uppercase"><span className="size-1.5 rounded-full bg-gold-500" /> Your data stays yours · Your authority stays yours</div>
          </div>
        </section>
      </main>
    </div>
  );
}
