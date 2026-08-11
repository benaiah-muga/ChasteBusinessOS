"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { getApiClient, setStoredAuthToken } from "@/lib/api";

const api = getApiClient();

export default function LoginPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const credential = token.trim();
    if (!credential) {
      setError("Paste the invite or onboarding token that was shared with you.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(credential);
      setStoredAuthToken(res.token ?? credential);
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed. Check the token and try again.");
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <div className="brand-mark">
            <ShieldCheck size={22} />
          </div>
          <div>
            <div className="brand-word">ChasteBusinessOS</div>
            <div className="brand-sub">Governed business operations</div>
          </div>
        </div>

        <h1>Sign in to your workspace</h1>
        <p className="muted auth-lead">
          This instance uses token-based access. Ask your workspace admin for your invite or
          onboarding credential, then paste it below.
        </p>

        <div className="field auth-field">
          <span>Access token</span>
          <div className="auth-input-wrap">
            <KeyRound size={15} />
            <input
              type="password"
              autoComplete="off"
              autoFocus
              placeholder="Paste your token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
        </div>

        {error ? <p className="auth-error">{error}</p> : null}

        <div className="form-actions auth-actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Verifying…" : "Sign in"}
          </button>
        </div>

        <p className="auth-footnote">
          The token is validated against the API and stored only in this browser for subsequent
          requests.
        </p>
      </form>
    </main>
  );
}