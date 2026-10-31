import { useEffect, useState, type FormEvent } from "react";
import { authClient } from "../api/auth";
import { navigate } from "../navigation";
import "./LoginPage.css";

type ResetLinkState = { token: string | null; invalid: boolean };

function readResetLink(): ResetLinkState {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const invalid = params.get("error") === "INVALID_TOKEN" || !token;
  return { token, invalid };
}

export function PasswordResetPage() {
  const [link] = useState(readResetLink);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    // Remove the one-time link token from browser history after capturing it.
    window.history.replaceState(null, "", "/reset-password");
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!link.token || link.invalid) return;
    if (password !== confirmation) {
      setError("Those passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.resetPassword(link.token, password);
      if (result.error) throw new Error(result.error.message);
      setComplete(true);
    } catch (resetError) {
      const message = resetError instanceof Error ? resetError.message : "";
      setError(message.toLowerCase().includes("password")
        ? "Use a password between 8 and 128 characters."
        : message.toLowerCase().includes("token")
          ? "This reset link is invalid or expired. Request a new one from sign in."
          : "We could not reset your password. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  const expired = link.invalid || (!link.token && !complete);

  return (
    <>
      <title>Reset password | Chaste BusinessOS</title>
      <main className="login-page login-recovery-page">
        <section className="login-panel" aria-label="Reset your password">
          <div className="login-card-wrap">
            <div className="login-card">
              <div className="login-card-heading">
                <div>
                  <p className="login-card-eyebrow">Account recovery</p>
                  <h2>{complete ? "Password updated." : expired ? "This link has expired." : "Choose a new password."}</h2>
                  <p>{complete ? "Your password has been changed. Sign in with the new password." : expired ? "Request a new password reset link from the sign-in page." : "Set a password between 8 and 128 characters."}</p>
                </div>
              </div>

              {complete || expired ? (
                <div className="login-verification">
                  {complete && <p className="login-verification-message" role="status">Your password was changed successfully.</p>}
                  <button className="login-submit" type="button" onClick={() => navigate("/login", true)}>Go to sign in <span aria-hidden="true">→</span></button>
                </div>
              ) : (
                <form className="login-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
                  <div className="login-field">
                    <label htmlFor="reset-password">New password</label>
                    <input id="reset-password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={password} onChange={(event) => setPassword(event.currentTarget.value)} />
                  </div>
                  <div className="login-field">
                    <label htmlFor="reset-confirmation">Confirm new password</label>
                    <input id="reset-confirmation" type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} />
                  </div>
                  {error && <p className="login-error" role="alert">{error}</p>}
                  <button className="login-submit" type="submit" disabled={busy}>{busy ? "Updating…" : "Update password"}</button>
                </form>
              )}
            </div>
            <div className="login-trust-note"><span aria-hidden="true" /> Your data stays yours · Your authority stays yours</div>
          </div>
        </section>
      </main>
    </>
  );
}
