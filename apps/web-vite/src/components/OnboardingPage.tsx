import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { authClient } from "../api/auth";
import { fetchOrganizations, OrganizationApiError } from "../api/organizations";
import { OnboardingApiError, readOnboardingState, type OnboardingState } from "../api/onboarding";
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
type ResumeSetup = { organizationId: string; baseCurrency: string; state: OnboardingState };
type GateState =
  | { status: "loading" }
  | { status: "ready"; user: SessionUser; resume?: ResumeSetup }
  | { status: "failed"; message: string };

/**
 * Setup is the one screen a brand-new user sees before anything exists, and it
 * renders outside the authenticated shell, so it answers three questions
 * itself: are they signed in, do they already have a workspace, and who are we
 * talking to. The legacy route resolved all three server-side; here the session
 * comes from the existing auth client and the workspace check from the
 * organization list. An unfinished setup is the exception: the import receipt
 * recovery controls live in the wizard, so that workspace resumes in place.
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

    let organizations: Awaited<ReturnType<typeof fetchOrganizations>>;
    try {
      organizations = await fetchOrganizations();
    } catch (error) {
      if (error instanceof OrganizationApiError && error.status === 401) {
        navigate("/login", true);
        return;
      }
      setGate({ status: "failed", message: "We could not check whether you already have a workspace. Try again." });
      return;
    }

    if (organizations.orgs.length > 0) {
      const activeOrganization = organizations.orgs.find((org) => org.id === organizations.activeOrgId)
        ?? (organizations.orgs.length === 1 ? organizations.orgs[0] : undefined);
      if (!activeOrganization) {
        setGate({ status: "failed", message: "Choose an active workspace before checking setup progress." });
        return;
      }
      let onboardingState: OnboardingState | null;
      try {
        onboardingState = await readOnboardingState();
      } catch (error) {
        if (error instanceof OnboardingApiError && error.status === 401) {
          navigate("/login", true);
          return;
        }
        setGate({ status: "failed", message: "We could not check your setup progress. Try again." });
        return;
      }
      if (onboardingState && !onboardingState.finishedAt) {
        setGate({
          status: "ready",
          user,
          resume: {
            organizationId: activeOrganization.id,
            baseCurrency: activeOrganization.baseCurrency ?? "USD",
            state: onboardingState,
          },
        });
        return;
      }
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
        <OnboardingWizard
          email={gate.user.email}
          actorId={gate.user.id}
          organizationId={gate.resume?.organizationId}
          baseCurrency={gate.resume?.baseCurrency}
          resumeState={gate.resume?.state}
        />
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
