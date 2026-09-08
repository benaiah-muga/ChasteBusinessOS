"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAuthClient } from "better-auth/client";
import {
  IconAlertTriangle,
  IconArrowsHorizontal,
  IconBookOpen,
  IconEye,
  IconEyeOff,
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
    body: "A hash-chained event trail records who did what — human or agent — forever.",
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

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  function toggleMode() {
    setMode(mode === "signup" ? "signin" : "signup");
    setError(null);
  }

  return (
    <div className="min-h-screen bg-sand-50 font-display text-ink">
      {/* Sticky header. The avatar and magnifier are the app chrome; on the
          auth surface there is no session behind them yet. */}
      <header className="sticky top-0 z-10 border-b border-sand-200 bg-sand-50/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gold-500 text-sm font-bold text-white">
              C
            </span>
            <span className="text-sm leading-tight">
              <span className="font-semibold">Chaste Business OS</span>
              <span className="hidden text-ink-muted md:inline">
                {" "}
                — The operating system for your business
              </span>
            </span>
          </div>

          <div className="flex items-center gap-3">
            <IconSearch className="size-4 text-ink-muted" aria-hidden="true" />
            <span className="flex size-8 items-center justify-center rounded-full bg-sand-200 text-sm font-semibold text-ink">
              N
            </span>
          </div>
        </div>
      </header>

      <main className="grid min-h-[calc(100vh-3.5rem)] lg:grid-cols-2">
        {/* ── Left: the auth card ─────────────────────────────────────── */}
        <section className="flex items-center justify-center bg-sand-100 px-5 py-12">
          <div className="w-full max-w-md rounded-xl bg-cream p-7 shadow-md ring-1 ring-sand-200 sm:p-8">
            <h2 className="text-[26px] leading-tight font-bold tracking-tight">Welcome back</h2>
            <p className="mt-1.5 text-sm text-ink-muted">
              {mode === "signup" ? "Create your workspace to get started." : "Sign in to your workspace."}
            </p>

            <form onSubmit={submit} className="mt-7 space-y-4">
              {mode === "signup" && (
                <div>
                  <label htmlFor="name" className="mb-1.5 block text-[13px] leading-none font-medium text-ink">
                    Your name
                  </label>
                  <input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    placeholder="Ada Lovelace"
                    className="h-10 w-full rounded-lg border border-sand-300 bg-white px-3 text-sm text-ink transition-colors outline-none placeholder:text-ink-muted/55 focus:border-gold-500 focus:ring-[3px] focus:ring-gold-500/20"
                  />
                </div>
              )}

              <div>
                <label htmlFor="email" className="mb-1.5 block text-[13px] leading-none font-medium text-ink">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="you@company.com"
                  className="h-10 w-full rounded-lg border border-sand-300 bg-white px-3 text-sm text-ink transition-colors outline-none placeholder:text-ink-muted/55 focus:border-gold-500 focus:ring-[3px] focus:ring-gold-500/20"
                />
              </div>

              <div>
                <label htmlFor="password" className="mb-1.5 block text-[13px] leading-none font-medium text-ink">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    placeholder="At least 8 characters"
                    className="h-10 w-full rounded-lg border border-sand-300 bg-white pr-10 pl-3 text-sm text-ink transition-colors outline-none placeholder:text-ink-muted/55 focus:border-gold-500 focus:ring-[3px] focus:ring-gold-500/20"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute inset-y-0 right-0 flex w-10 cursor-pointer items-center justify-center rounded-r-lg text-ink-muted transition-colors hover:text-ink"
                  >
                    {showPassword ? <IconEyeOff className="size-4" /> : <IconEye className="size-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
                >
                  <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-gold-500 text-sm font-semibold text-white shadow-sm transition-colors duration-150 hover:bg-gold-600 focus-visible:ring-[3px] focus-visible:ring-gold-500/30 focus-visible:outline-none active:bg-gold-700 disabled:cursor-not-allowed disabled:opacity-55"
              >
                {busy && <Spinner />}
                {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-ink-muted">
              {mode === "signup" ? "Already have an account?" : "New to Chaste?"}{" "}
              <button
                type="button"
                onClick={toggleMode}
                className="cursor-pointer font-semibold text-gold-700 underline-offset-2 hover:underline"
              >
                {mode === "signup" ? "Sign in" : "Create an account"}
              </button>
            </p>
          </div>
        </section>

        {/* ── Right: value props ──────────────────────────────────────── */}
        <section className="flex flex-col items-center justify-center gap-10 bg-sand-50 px-6 py-14 text-center">
          <h1 className="max-w-xl text-[32px] leading-[1.15] font-bold tracking-tight text-balance sm:text-[40px]">
            Describe your business. Your AI workmate runs it,{" "}
            <span className="text-ink-muted">under your authority.</span>
          </h1>

          <div className="grid w-full max-w-lg gap-4">
            {VALUE_PROPS.map(({ num, title, body, Icon }) => (
              <div
                key={num}
                className="flex items-start gap-4 rounded-xl bg-cream p-5 text-left shadow-md ring-1 ring-sand-200"
              >
                <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-gold-500/12 text-gold-600">
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-bold tracking-[0.1em] text-gold-600 uppercase">
                    {num} {title}
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
