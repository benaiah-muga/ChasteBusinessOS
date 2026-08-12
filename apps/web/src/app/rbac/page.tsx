import { redirect } from "next/navigation";

export default function RbacRedirect() {
  redirect("/settings?tab=access");
}
