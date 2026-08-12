import { redirect } from "next/navigation";

export default function DataRedirect() {
  redirect("/settings?tab=data");
}
