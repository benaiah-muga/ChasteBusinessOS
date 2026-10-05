import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { authClient } from "../api/auth";
import { fetchOrganizations, OrganizationApiError } from "../api/organizations";
import { navigate } from "../navigation";
import { OnboardingWizard } from "./onboarding/Wizard";
import "./OnboardingPage.css";

// Passthrough, not strict: the auth client returns more session fields than
// the wizard needs, and a strict parse would reject every real session.
const SessionUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  email: z.string().email(),
}).passthrough();

type SessionUser = z.infer<typeof SessionUserSchema>;
type GateState =
  | { status: "loading" }
  | { status: "ready"; user: SessionUser }
  | { status: "failed"; message: string };

/**
 * Setup is the one screen a brand-new user sees before anything exists, and it
 * renders outside the authenticated shell, so it answers three questions
 * itself: are they signed in, do they already have a workspace, and who are we
 * talking to. The legacy route resolved all three server-side; here the session
 * comes from the existing auth client and the workspace check from the
 * organization list. Landing here with a workspace already open is always a
 * mistake, and it is cheaper to redirect than to explain why the wizard refuses.
 */
export function OnboardingPage() {
  const [gate, setGate] = useState<GateState>({ status: "loading" });

  const resolve = useCallback(async () => {
    setGate({ status: "loading" });
    let user: SessionUser;
    try {
      const session = await authClient.getSession();
      const parsed = SessionUserSchema.safeParse(session.data?.user);
      if (!parsed.success) {
        navigate("/login", true);
        return;
      }
      user = parsed.data;
    } catch {
      setGate({ status: "failed", message: "The existing sign-in service did not respond. Try again before opening a workspace." });
      return;
    }

    let memberships: { id: string }[];
    try {
      memberships = (await fetchOrganizations()).orgs;
    } catch (error) {
      if (error instanceof OrganizationApiError && error.status === 401) {
        navigate("/login", true);
        return;
      }
      setGate({ status: "failed", message: "We could not check whether you already have a workspace. Try again." });
      return;
    }

    if (memberships.length > 0) {
      navigate("/", true);
      return;
    }
    setGate({ status: "ready", user });
  }, []);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  if (gate.status === "ready") {
    return (
      <>
        <title>Set up your workspace | Chaste BusinessOS</title>
        <OnboardingWizard email={gate.user.email} />
      </>
    );
  }

  if (gate.status === "failed") {
    return (
      <main className="auth-problem">
        <p className="shell-kicker">Workspace setup</p>
        <h1>We could not check your session.</h1>
        <p role="alert">{gate.message}</p>
        <button className="shell-button" type="button" onClick={() => void resolve()}>Try again</button>
        <a href="/login">Go to sign in</a>
      </main>
    );
  }

  return <main className="auth-wait" role="status">Checking your workspace session…</main>;
}
