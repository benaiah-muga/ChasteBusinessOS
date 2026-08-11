import { redirect } from "next/navigation";

export default function AuditRedirect() {
  redirect("/settings?tab=audit");
}
