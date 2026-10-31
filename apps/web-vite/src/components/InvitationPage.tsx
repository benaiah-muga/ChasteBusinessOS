import { useEffect, useMemo, useState } from "react";
import { authClient } from "../api/auth";
import { InvitationApiError, invitationsApi, type InvitationPreview } from "../api/invitations";
import { navigate } from "../navigation";
import "./InvitationPage.css";

type InvitationSession = { email: string; emailVerified: boolean } | null;

function invitationMessage(error: unknown): string {
  if (!(error instanceof InvitationApiError)) return "We could not load this invitation. Try again in a moment.";
  if (error.status === 401) return "Sign in with the invited email address to continue.";
  if (error.status === 403) {
    const message = error.message.toLowerCase();
    if (message.includes("verif")) return "Verify your email address, then sign in again before accepting this invitation.";
    if (message.includes("email") || message.includes("match")) return "This invitation was sent to a different email address. Sign in with the invited address to accept it.";
  }
  if (error.status === 404) return "This invitation is invalid, has been revoked, or has already been accepted.";
  if (error.status === 410) return "This invitation has expired. Ask a workspace owner to send a new one.";
  return error.message;
}

function signInPath(returnPath: string): string {
  return `/login?returnTo=${encodeURIComponent(returnPath)}`;
}

export function InvitationPage({ pathname }: { pathname: string }) {
  const token = useMemo(() => pathname.split("/").at(-1) ?? "", [pathname]);
  const returnPath = `${pathname}${window.location.search}`;
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [session, setSession] = useState<InvitationSession | "loading">("loading");
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setPreview(null);
    setAccepted(false);
    setSession("loading");

    void Promise.all([
      invitationsApi.preview(token),
      authClient.getSession().catch(() => ({ data: null, error: { message: "Session lookup failed" } })),
    ]).then(([invitation, auth]) => {
      if (!active) return;
      setPreview(invitation);
      setSession(auth.data?.user ? { email: auth.data.user.email, emailVerified: auth.data.user.emailVerified === true } : null);
    }).catch((reason: unknown) => {
      if (active) setError(invitationMessage(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => { active = false; };
  }, [token]);

  async function acceptInvitation() {
    const signedInSession = typeof session === "object" && session !== null ? session : null;
    if (!preview || !signedInSession?.emailVerified || accepting) return;
    setAccepting(true);
    setError(null);
    try {
      await invitationsApi.accept(token);
      setAccepted(true);
    } catch (reason) {
      setError(invitationMessage(reason));
    } finally {
      setAccepting(false);
    }
  }

  async function switchToInvitedAccount() {
    const result = await authClient.signOut();
    if (result.error) {
      setError("We could not sign out this account. Try again.");
      return;
    }
    navigate(signInPath(returnPath), true);
  }

  const signedInSession = typeof session === "object" && session !== null ? session : null;
  const emailMatches = preview && signedInSession && preview.email.trim().toLowerCase() === signedInSession.email.trim().toLowerCase();

  return (
    <main className="invitation-page">
      <title>Workspace invitation | Chaste BusinessOS</title>
      <section className="invitation-card" aria-busy={loading || accepting}>
        <a className="invitation-brand" href="/" aria-label="Chaste BusinessOS home"><span aria-hidden="true">C</span> Chaste BusinessOS</a>
        <p className="invitation-kicker">Workspace invitation</p>
        <h1>{accepted ? "You’re in." : "Join your team."}</h1>

        {loading ? <p role="status">Loading invitation…</p> : preview ? (
          <>
            <p className="invitation-intro">You’ve been invited to join a workspace. Review the invitation details below.</p>
            <dl className="invitation-details">
              <div><dt>Workspace</dt><dd>{preview.orgName}</dd></div>
              <div><dt>Role</dt><dd>{preview.roleName}</dd></div>
              <div><dt>Invited email</dt><dd>{preview.email}</dd></div>
              <div><dt>Expires</dt><dd>{new Date(preview.expiresAt).toLocaleString()}</dd></div>
            </dl>
            {accepted ? (
              <div className="invitation-success" role="status">
                <p>Your invitation was accepted. Continue to your workspace.</p>
                <button type="button" className="invitation-primary" onClick={() => navigate("/", true)}>Open workspace</button>
              </div>
            ) : session === "loading" ? <p role="status">Checking your sign-in…</p> : !signedInSession ? (
              <div className="invitation-signin">
                <p>Sign in with <strong>{preview.email}</strong> to verify the invited account and accept.</p>
                <a className="invitation-primary" href={signInPath(returnPath)}>Sign in to accept</a>
              </div>
            ) : !emailMatches ? (
              <div className="invitation-signin">
                <p className="invitation-error" role="alert">You’re signed in as <strong>{signedInSession.email}</strong>, but this invitation is for <strong>{preview.email}</strong>. Sign out, then sign in with the invited address.</p>
                <button className="invitation-secondary" type="button" onClick={() => void switchToInvitedAccount()}>Switch account</button>
              </div>
            ) : !signedInSession.emailVerified ? (
              <div className="invitation-signin">
                <p className="invitation-error" role="alert">Verify <strong>{signedInSession.email}</strong> before accepting. Open the verification email, then sign in again with this address.</p>
                <button className="invitation-secondary" type="button" onClick={() => void switchToInvitedAccount()}>Sign out and sign in again</button>
              </div>
            ) : (
              <div className="invitation-accept">
                <p>Verified and signed in as <strong>{signedInSession.email}</strong>.</p>
                <button className="invitation-primary" type="button" onClick={() => void acceptInvitation()} disabled={accepting}>
                  {accepting ? "Accepting…" : "Accept invitation"}
                </button>
              </div>
            )}
          </>
        ) : null}

        {error && <p className="invitation-error" role="alert">{error}</p>}
        {!loading && !preview && <a className="invitation-secondary" href={signInPath(returnPath)}>Go to sign in</a>}
      </section>
    </main>
  );
}
