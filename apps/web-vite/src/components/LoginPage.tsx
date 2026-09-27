import { useEffect, useState, type FormEvent } from "react";
import { authClient } from "../api/auth";
import { navigate } from "../navigation";
import "./LoginPage.css";

const valueProps = [
  { number: "01", title: "Governed", text: "Nothing acts silently." },
  { number: "02", title: "Auditable", text: "Every action leaves a trail." },
  { number: "03", title: "Reversible", text: "Corrections are mirror reversals." },
];

function authErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.toLowerCase();
  if (normalized.includes("verif")) {
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

function Spinner() {
  return (
    <svg className="login-spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="login-brand">
      <span className={compact ? "login-mark login-mark-compact" : "login-mark"} aria-hidden="true">C</span>
      <span>
        <strong>Chaste Business OS</strong>
        <small>The AI-native business operating system</small>
      </span>
    </div>
  );
}

export function LoginPage() {
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
    void authClient.getSession().then((result) => {
      if (mounted && result.data?.user) navigate("/", true);
    }).catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedMode = mode;
    setBusy(true);
    setError(null);
    try {
      const result = submittedMode === "signup"
        ? await authClient.signUp.email({
            email,
            password,
            name: name || (email.split("@")[0] ?? "Founder"),
          })
        : await authClient.signIn.email({ email, password });
      if (result.error) throw new Error(result.error.message ?? "authentication failed");
      if (submittedMode === "signup" && result.data?.token == null) {
        setVerifySent(true);
        setBusy(false);
        return;
      }
      navigate("/", true);
    } catch (submitError) {
      setError(authErrorMessage(submitError));
      setBusy(false);
    }
  }

  function toggleMode() {
    setMode((current) => current === "signup" ? "signin" : "signup");
    setError(null);
    setVerifySent(false);
  }

  return (
    <>
    <title>Sign in | Chaste BusinessOS</title>
    <main className="login-page">
      <section className="login-story" aria-label="About Chaste Business OS">
        <div className="login-orbit login-orbit-one" aria-hidden="true" />
        <div className="login-orbit login-orbit-two" aria-hidden="true" />
        <Brand />
        <div className="login-story-copy">
          <p className="login-overline">Open source · built for everyone</p>
          <h1>Run the business.<span>Keep the authority.</span></h1>
          <p className="login-story-lede">
            Describe your business. Your AI workmate runs it under your authority,
            with every action governed, auditable, and reversible.
          </p>
          <div className="login-value-props">
            {valueProps.map((item) => (
              <div className="login-value-prop" key={item.number}>
                <span>{item.number}</span>
                <strong>{item.title}</strong>
                <small>{item.text}</small>
              </div>
            ))}
          </div>
        </div>
        <div className="login-story-footer"><span>Simple to adopt.</span><span>Powerful to grow.</span></div>
      </section>

      <section className="login-panel" aria-label="Sign in or create an account">
        <div className="login-card-wrap">
          <div className="login-mobile-brand"><Brand compact /></div>
          <div className="login-card">
            <div className="login-card-heading">
              <div>
                <p className="login-card-eyebrow">
                  {verifySent ? "One more step" : mode === "signup" ? "Create your workspace" : "Welcome back"}
                </p>
                <h2>{verifySent ? "Check your inbox." : mode === "signup" ? "Start with clarity." : "Good to see you."}</h2>
                <p>{verifySent ? "Confirm your email to open the door." : mode === "signup" ? "Create your workspace to get started." : "Sign in to your workspace."}</p>
              </div>
              <span className="login-card-badge" aria-hidden="true">{verifySent ? "✉" : mode === "signup" ? "01" : "↗"}</span>
            </div>

            {verifySent ? (
              <div className="login-verification">
                <div className="login-verification-message" role="status">
                  <span aria-hidden="true">✉</span>
                  <p>
                    We sent a verification link to <strong>{email.trim()}</strong>. Click it to prove
                    the address is yours - then sign in and we&apos;ll take you straight into setup.
                  </p>
                </div>
                <p className="login-hint">No email? Check spam, or try signing in - that sends a fresh link automatically.</p>
                <button className="login-text-button login-back-button" type="button" onClick={toggleMode}>
                  <span aria-hidden="true">←</span> Back to sign in
                </button>
              </div>
            ) : (
              <>
                <form className="login-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
                  {mode === "signup" && (
                    <div className="login-field">
                      <label htmlFor="login-name">Your name</label>
                      <input
                        id="login-name"
                        name="name"
                        autoComplete="name"
                        placeholder="Ada Lovelace"
                        value={name}
                        onChange={(event) => setName(event.currentTarget.value)}
                      />
                    </div>
                  )}

                  <div className="login-field">
                    <label htmlFor="login-email">Email</label>
                    <input
                      id="login-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      placeholder="you@company.com"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.currentTarget.value)}
                    />
                  </div>

                  <div className="login-field">
                    <label htmlFor="login-password">Password</label>
                    <div className="login-password-wrap">
                      <input
                        id="login-password"
                        name="password"
                        type={showPassword ? "text" : "password"}
                        autoComplete={mode === "signup" ? "new-password" : "current-password"}
                        placeholder="At least 8 characters"
                        required
                        minLength={8}
                        value={password}
                        onChange={(event) => setPassword(event.currentTarget.value)}
                      />
                      <button
                        className="login-password-toggle"
                        type="button"
                        onClick={() => setShowPassword((visible) => !visible)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        aria-pressed={showPassword}
                      >
                        {showPassword ? (
                          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.7a2 2 0 002.7 2.7M9.9 5.2A10.8 10.8 0 0112 5c5.5 0 9 7 9 7a14 14 0 01-3.1 3.9M6.2 6.3C3.9 7.8 2.5 12 2.5 12s3.5 7 9.5 7a9 9 0 003-.5" /></svg>
                        ) : (
                          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" /><circle cx="12" cy="12" r="2.5" /></svg>
                        )}
                      </button>
                    </div>
                  </div>

                  {error && (
                    <p className="login-error" role="alert">
                      <span aria-hidden="true">!</span><span>{error}</span>
                    </p>
                  )}

                  <button className="login-submit" type="submit" disabled={busy}>
                    {busy && <Spinner />}
                    {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
                    {!busy && <span aria-hidden="true">→</span>}
                  </button>
                </form>

                <p className="login-mode-switch">
                  {mode === "signup" ? "Already have an account?" : "New to Chaste?"}{" "}
                  <button className="login-text-button" type="button" onClick={toggleMode}>
                    {mode === "signup" ? "Sign in" : "Create an account"}
                  </button>
                </p>
              </>
            )}
          </div>
          <div className="login-trust-note"><span aria-hidden="true" /> Your data stays yours · Your authority stays yours</div>
        </div>
      </section>
    </main>
    </>
  );
}
