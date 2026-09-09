import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getResolvedUser } from "@/server/session";
import { OnboardingWizard } from "@/components/onboarding/wizard";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = { title: "Set up your workspace" };

/**
 * Setup is the one screen a brand-new user sees before anything exists, so it
 * resolves three things for them on the server: are they signed in, do they
 * already have a workspace, and who are we talking to. Landing here with a
 * workspace already open is always a mistake, and it is cheaper to redirect
 * than to explain why the wizard is refusing.
 */
export default async function OnboardingPage() {
  const user = await getResolvedUser();
  if (!user) redirect("/login");
  if (user.orgId) redirect("/");

  return <OnboardingWizard email={user.email} />;
}
