import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Chaste Business OS",
    template: "%s · Chaste",
  },
  description:
    "The agentic ERP, describe your business, and an AI co-worker runs it under your authority. Every action governed, auditable, reversible.",
};

export const viewport: Viewport = {
  themeColor: "#5e2934",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans text-stone-900 antialiased">{children}</body>
    </html>
  );
}
