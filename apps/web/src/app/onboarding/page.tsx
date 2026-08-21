"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function OnboardingPage() {
  const router = useRouter();
  const [orgName, setOrgName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgName, businessDescription: description }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "onboarding failed");
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-16">
      <p className="mb-2 font-mono text-xs uppercase tracking-widest text-emerald-700">Setup</p>
      <h1 className="mb-3 text-3xl font-semibold tracking-tight">Tell us about your business</h1>
      <p className="mb-8 text-neutral-600">
        Describe what you do in plain language. Chaste uses this to configure your workspace,
        seed your books, and give your AI co-worker lasting context.
      </p>

      <form onSubmit={submit} className="space-y-5">
        <label className="block text-sm">
          Business name
          <input
            required
            minLength={2}
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Glow Works Ltd"
            className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 focus:border-emerald-600 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          What does your business do? Who are your customers? How do you make money?
          <textarea
            required
            minLength={20}
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="We design and sell handmade lighting fixtures online and to interior designers. Most customers order 10–50 units at a time. We offer 2% discount to returning wholesale buyers…"
            className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 leading-relaxed focus:border-emerald-600 focus:outline-none"
          />
        </label>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-emerald-700 px-6 py-2.5 font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {busy ? "Setting up…" : "Set up my workspace"}
        </button>
      </form>
    </main>
  );
}
