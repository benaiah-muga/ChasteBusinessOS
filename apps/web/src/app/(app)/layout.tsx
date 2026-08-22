import { redirect } from "next/navigation";
import Link from "next/link";
import { getResolvedUser } from "@/server/session";
import { auth } from "@/server/auth";
import { headers } from "next/headers";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const resolved = await getResolvedUser();
  if (!resolved) redirect("/login");
  if (!resolved.orgId) redirect("/onboarding");

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
          <Link href="/messages" className="text-neutral-600 hover:text-neutral-900">Messages</Link>
          <Link href="/sessions" className="text-neutral-600 hover:text-neutral-900">Sessions</Link>
          <Link href="/approvals" className="text-neutral-600 hover:text-neutral-900">Approvals</Link>
          <Link href="/ledger" className="text-neutral-600 hover:text-neutral-900">Event Ledger</Link>
          <form action={signOut} className="ml-auto">
            <button type="submit" className="text-neutral-400 hover:text-neutral-700">Sign out</button>
          </form>
        </div>
      </nav>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
