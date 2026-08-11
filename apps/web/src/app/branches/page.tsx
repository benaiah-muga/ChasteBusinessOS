import { redirect } from "next/navigation";

export default function BranchesRedirect() {
  redirect("/settings?tab=branches");
}
