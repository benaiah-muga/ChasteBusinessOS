import type { Metadata, Viewport } from "next";
import "./globals.css";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: {
    default: "Chaste Business OS",
    template: "%s · Chaste",
  },
  description:
    "The agentic ERP, describe your business, and an AI workmate runs it under your authority. Every action governed, auditable, reversible.",
};

export const viewport: Viewport = {
  themeColor: "#38000a",
};

// Apply the persisted theme before first paint so there is no flash.
const themeInit = `try{var t=localStorage.getItem("chaste-theme");if(t&&t!=="chaste")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-screen bg-canvas font-sans text-stone-900 antialiased">{children}</body>
    </html>
  );
}
