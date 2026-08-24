"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Notice } from "@/components/ui";
import { IconLandmark, IconSparkle, IconUsers } from "@/components/icons";

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
    <main className="mx-auto flex min-h-screen max-w-5xl items-center px-6 py-16">
      <div className="grid w-full gap-12 lg:grid-cols-[1fr_1.2fr] lg:items-center">
        {/* Context panel */}
        <section className="hidden lg:block">
          <span className="inline-flex items-center gap-2 text-xs font-semibold tracking-widest text-maroon-700 uppercase">
            <IconSparkle className="size-4" />
            Workspace setup
          </span>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance text-stone-900">
            Your books, seeded by a sentence.
          </h1>
          <p className="mt-4 leading-relaxed text-stone-600">
            Describe what you do in plain language, the same way you'd explain it to a new
            bookkeeper. Chaste takes it from there.
          </p>
          <ul className="mt-8 space-y-4 text-sm text-stone-600">
            <li className="flex gap-3">
              <IconLandmark className="mt-0.5 size-4 shrink-0 text-maroon-700" />
              Your chart of accounts is seeded and your books open balanced.
            </li>
            <li className="flex gap-3">
              <IconSparkle className="mt-0.5 size-4 shrink-0 text-maroon-700" />
              Your AI co-worker reads this once and remembers it forever.
            </li>
            <li className="flex gap-3">
              <IconUsers className="mt-0.5 size-4 shrink-0 text-maroon-700" />
              You become the owner with full authority over every gated action.
            </li>
          </ul>
        </section>

        {/* Form */}
        <section>
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <IconSparkle className="size-4 text-maroon-700" />
            <p className="text-xs font-semibold tracking-widest text-maroon-700 uppercase">Workspace setup</p>
          </div>
          <form onSubmit={submit} className="card card-pad sm:p-6">
            <div className="mb-5">
              <label htmlFor="orgName" className="label">
                Business name
              </label>
              <input
                id="orgName"
                required
                minLength={2}
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Glow Works Ltd"
                className="input"
              />
            </div>
            <div className="mb-5">
              <label htmlFor="description" className="label">
                What does your business do?
              </label>
              <textarea
                id="description"
                required
                minLength={20}
                rows={7}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="We design and sell handmade lighting fixtures online and to interior designers. Most customers order 10–50 units at a time. We offer 2% discount to returning wholesale buyers…"
                className="textarea resize-none"
              />
              <div className="mt-1.5 flex justify-between text-xs text-stone-400">
                <span>Who are your customers? How do you make money?</span>
                <span aria-hidden="true">{description.length}/20 min</span>
              </div>
            </div>

            {error && (
              <Notice tone="error" onDismiss={() => setError(null)}>
                {error}
              </Notice>
            )}

            <Button type="submit" size="lg" loading={busy} disabled={description.trim().length < 20 || orgName.trim().length < 2}>
              {busy ? "Setting up…" : "Set up my workspace"}
            </Button>
          </form>
        </section>
      </div>
    </main>
  );
}
