"use client";

import { BriefcaseBusiness, CircleDollarSign, ShoppingCart, UserPlus } from "lucide-react";
import type { ComponentType } from "react";

type QuickActionIcon = "customer" | "invoice" | "payroll" | "vendor";

const icons = {
  customer: UserPlus,
  invoice: CircleDollarSign,
  payroll: BriefcaseBusiness,
  vendor: ShoppingCart,
} satisfies Record<QuickActionIcon, ComponentType<{ size?: number }>>;

export function QuickActionButton({
  icon,
  title,
  subtitle,
  prompt,
}: {
  icon: QuickActionIcon;
  title: string;
  subtitle: string;
  prompt: string;
}) {
  const Icon = icons[icon];

  return (
    <button
      className="quick-action"
      type="button"
      onClick={() => {
        window.dispatchEvent(new CustomEvent("chaste-agent-message", { detail: { prompt } }));
      }}
    >
      <Icon size={21} />
      <span>
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </span>
    </button>
  );
}
