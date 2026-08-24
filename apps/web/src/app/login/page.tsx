"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createAuthClient } from "better-auth/client";
import { Button, Notice } from "@/components/ui";
import { IconAlertTriangle, IconEye, IconEyeOff, IconLandmark, IconShieldCheck, IconSparkle } from "@/components/icons";

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
    <main className="grid min-h-screen lg:grid-cols-[1fr_460px]">
      {/* Brand panel */}
      <section className="relative hidden flex-col justify-between overflow-hidden bg-maroon-950 p-12 text-white lg:flex">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{
            background:
              "radial-gradient(600px circle at 20% 10%, rgba(164,90,102,0.5), transparent 55%), radial-gradient(500px circle at 80% 85%, rgba(138,65,79,0.6), transparent 55%)",
          }}
        />
        <div className="relative">
          <span className="inline-flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
              <IconSparkle className="size-5" />
            </span>
            <span className="text-lg font-semibold tracking-tight">Chaste Business OS</span>
          </span>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-[28px] leading-snug font-semibold tracking-tight text-balance">
            Describe your business. Your AI co-worker runs it, under your authority.
          </h1>
          <ul className="mt-8 space-y-4 text-sm text-maroon-100/90">
            <li className="flex gap-3">
              <IconSparkle className="mt-0.5 size-4 shrink-0 text-maroon-300" />
              Ask in plain language: create customers, invoice, pay bills, run payroll.
            </li>
            <li className="flex gap-3">
              <IconShieldCheck className="mt-0.5 size-4 shrink-0 text-maroon-300" />
              Every money and identity action waits for your approval. Nothing acts silently.
            </li>
            <li className="flex gap-3">
              <IconLandmark className="mt-0.5 size-4 shrink-0 text-maroon-300" />
              Double-entry books that cannot lie, immutable postings, hash-chained audit trail.
            </li>
          </ul>
        </div>
        <p className="relative text-xs text-maroon-200/60">Governed · Auditable · Reversible</p>
      </section>

      {/* Form panel */}
      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="flex size-9 items-center justify-center rounded-lg bg-maroon-800 text-white">
              <IconSparkle className="size-5" />
            </span>
            <span className="text-lg font-semibold tracking-tight text-stone-900">Chaste Business OS</span>
          </div>

          <h2 className="text-xl font-semibold tracking-tight text-stone-900">
            {mode === "signup" ? "Create your account" : "Welcome back"}
          </h2>
          <p className="mt-1 mb-7 text-sm text-stone-500">
            {mode === "signup" ? "Set up your workspace in the next step." : "Sign in to your workspace."}
          </p>

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
                id="email"
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
