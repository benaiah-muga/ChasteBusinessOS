import { redirect } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { getDb, memberships, organizations } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { auth } from "@/server/auth";
import { headers } from "next/headers";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const resolved = await getResolvedUser();
  if (!resolved) redirect("/login");
  if (!resolved.orgId) redirect("/onboarding");

  const orgs = await getDb()
    .db.select({ id: organizations.id, name: organizations.name })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, resolved.userId));

  async function signOut() {
    "use server";
    await auth.api.signOut({ headers: await headers() });
    redirect("/login");
  }

  return (
    <div className="min-h-screen">
      <nav className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3 text-sm">
          <Link href="/" className="font-mono font-semibold tracking-tight text-emerald-800">
            Chaste
          </Link>
          <Link href="/" className="text-neutral-600 hover:text-neutral-900">Console</Link>
          <Link href="/accounting" className="text-neutral-600 hover:text-neutral-900">Accounting</Link>
          <Link href="/crm" className="text-neutral-600 hover:text-neutral-900">Pipeline</Link>
          <Link href="/pos" className="text-neutral-600 hover:text-neutral-900">POS</Link>
          <Link href="/documents" className="text-neutral-600 hover:text-neutral-900">Documents</Link>
          <Link href="/messages" className="text-neutral-600 hover:text-neutral-900">Messages</Link>
          <Link href="/sessions" className="text-neutral-600 hover:text-neutral-900">Sessions</Link>
          <Link href="/proposals" className="text-neutral-600 hover:text-neutral-900">Proposals</Link>
          <Link href="/team" className="text-neutral-600 hover:text-neutral-900">Team</Link>
          <Link href="/approvals" className="text-neutral-600 hover:text-neutral-900">Approvals</Link>
          <Link href="/ledger" className="text-neutral-600 hover:text-neutral-900">Event Ledger</Link>
          <form action={signOut} className="ml-auto flex items-center gap-4">
            {orgs.length > 1 && <OrgSwitcher orgs={orgs} activeId={resolved.orgId!} />}
            <button type="submit" className="text-neutral-400 hover:text-neutral-700">Sign out</button>
          </form>
        </div>
      </nav>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}

function OrgSwitcher({ orgs, activeId }: { orgs: { id: string; name: string }[]; activeId: string }) {
  return (
    <form action={switchOrg}>
      <select name="orgId" defaultValue={activeId} className="rounded border border-neutral-300 px-1.5 py-1 text-xs">
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
      <button type="submit" className="ml-1 text-xs text-emerald-700 underline underline-offset-2">
        switch
      </button>
    </form>
  );
}

async function switchOrg(formData: FormData) {
  "use server";
  const { cookies } = await import("next/headers");
  const { ACTIVE_ORG_COOKIE } = await import("@/server/session");
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ORG_COOKIE, String(formData.get("orgId")), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  });
  redirect("/");
}
