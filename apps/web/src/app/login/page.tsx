"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAuthClient } from "better-auth/client";
import { Button, Notice } from "@/components/ui";
import { IconAlertTriangle, IconEye, IconEyeOff } from "@/components/icons";

const authClient = createAuthClient();

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
          ? await authClient.signUp.email({ email, password, name: name || (email.split("@")[0] ?? "Founder") })
          : await authClient.signIn.email({ email, password });
      if (res.error) throw new Error(res.error.message ?? "authentication failed");
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_460px]">
      {/* The ledger panel: deep burgundy, ruled like an accounts book */}
      <section
        className="ledger-rules relative hidden flex-col justify-between overflow-hidden p-12 text-white lg:flex"
        style={{ background: "linear-gradient(160deg, var(--color-maroon-900), var(--color-maroon-950))" }}
      >
        {/* Wordmark */}
        <div className="relative flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-white/10 text-lg font-bold ring-1 ring-white/15">
            C
          </span>
          <div>
            <p className="text-[15px] leading-tight font-semibold tracking-tight">Chaste Business OS</p>
            <p className="text-xs text-white/40">The operating system for your business</p>
          </div>
        </div>

        {/* Statement */}
        <div className="relative max-w-lg">
          <h1 className="text-[32px] leading-[1.2] font-semibold tracking-tight text-balance">
            Describe your business.
            <br />
            Your AI co-worker runs it,
            <br />
            <span className="text-white/60">under your authority.</span>
          </h1>
        </div>

        {/* Proof points: numbered rows over hairlines, no icon soup */}
        <ul className="relative max-w-md">
          {[
            ["01", "Governed", "Every money and identity action waits for your approval. Nothing acts silently."],
            ["02", "Auditable", "A hash-chained event trail records who did what — human or agent — forever."],
            ["03", "Reversible", "Double-entry books that cannot lie. Corrections are mirror reversals, never edits."],
          ].map(([num, title, body]) => (
            <li key={num} className="border-t border-white/10 py-4 first:border-t-0">
              <div className="flex gap-4">
                <span className="tnum pt-0.5 text-xs font-medium text-white/30">{num}</span>
                <div>
                  <p className="text-sm font-semibold tracking-wide text-white/90 uppercase">{title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-white/50">{body}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>

        <p className="relative text-xs text-white/25">Governed · Auditable · Reversible</p>
      </section>

      {/* Form panel: paper, quiet, precise */}
      <section className="flex flex-col bg-canvas">
        {/* Compact brand strip on mobile */}
        <div className="flex items-center gap-2.5 px-6 pt-6 pb-2 lg:hidden" style={{ background: "linear-gradient(160deg, var(--color-maroon-900), var(--color-maroon-950))" }}>
          <span className="flex size-9 items-center justify-center rounded-lg bg-white/10 text-base font-bold ring-1 ring-white/15">C</span>
          <div>
            <p className="text-sm leading-tight font-semibold tracking-tight text-white">Chaste Business OS</p>
            <p className="text-[11px] text-white/40">Your AI co-worker, under your authority</p>
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-12">
          <div className="mb-7">
            <h2 className="text-xl font-semibold tracking-tight text-stone-900">
              {mode === "signup" ? "Create your workspace" : "Welcome back"}
            </h2>
            <p className="mt-1 mb-7 text-sm text-stone-500">
              {mode === "signup" ? "Set up your workspace in the next step." : "Sign in to your workspace."}
            </p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            {mode === "signup" && (
              <div>
                <label htmlFor="name" className="label">
                  Your name
                </label>
                <input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  placeholder="Ada Lovelace"
                  className="input"
                />
              </div>
            )}
            <div>
              <label htmlFor="email" className="label">
                Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@company.com"
                className="input"
              />
            </div>
            <div>
              <label htmlFor="password" className="label">
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
                  className="input pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex w-9 cursor-pointer items-center justify-center text-stone-400 hover:text-stone-600"
                >
                  {showPassword ? <IconEyeOff className="size-4" /> : <IconEye className="size-4" />}
                </button>
              </div>
            </div>

            {error && (
              <Notice tone="error">
                <span className="flex items-center gap-1.5">
                  <IconAlertTriangle className="size-4 shrink-0" />
                  {error}
                </span>
              </Notice>
            )}

            <Button type="submit" size="lg" loading={busy} className="w-full">
              {mode === "signup" ? "Create account" : "Sign in"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-stone-500">
            {mode === "signup" ? "Already have an account?" : "New to Chaste?"}{" "}
            <button
              type="button"
              onClick={() => {
                setMode(mode === "signup" ? "signin" : "signup");
                setError(null);
              }}
              className="cursor-pointer font-medium text-maroon-700 underline-offset-2 hover:underline"
            >
              {mode === "signup" ? "Sign in" : "Create an account"}
            </button>
          </p>
        </div>
      </section>
    </main>
  );
}
