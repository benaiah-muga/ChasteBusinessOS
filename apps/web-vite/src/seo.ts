const SITE_NAME = "ChasteBusinessOS";
const DEFAULT_IMAGE =
  "https://raw.githubusercontent.com/benaiah-muga/ChasteBusinessOS/main/assets/banner.png";
export const DEFAULT_DESCRIPTION =
  "ChasteBusinessOS is an open-source, AI-native business operating system. It gives a team one governed execution layer for finance, sales, purchasing, inventory, projects, CRM, support, documents, and people operations, with every material action auditable and reversible where supported.";

export type PageSeo = {
  title: string;
  description: string;
  robots: "index,follow" | "noindex,nofollow";
  image?: string;
};

function upsertMeta(attribute: "name" | "property", key: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(
    `meta[${attribute}="${key}"]`,
  );
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.setAttribute("content", content);
}

function upsertLink(rel: string, href: string) {
  let element = document.head.querySelector<HTMLLinkElement>(
    `link[rel="${rel}"]`,
  );
  if (!element) {
    element = document.createElement("link");
    element.setAttribute("rel", rel);
    document.head.appendChild(element);
  }
  element.setAttribute("href", href);
}

/**
 * Keeps the document head honest for the current route. The app is a private
 * workspace, so authenticated pages are explicitly noindex; only the public
 * sign-in entry is allowed to be indexed.
 */
export function applyPageSeo({
  title,
  description,
  robots,
  image = DEFAULT_IMAGE,
}: PageSeo) {
  const url = `${window.location.origin}${window.location.pathname}`;
  document.title = title;
  upsertMeta("name", "description", description);
  upsertMeta("name", "robots", robots);
  upsertMeta("property", "og:type", "website");
  upsertMeta("property", "og:site_name", SITE_NAME);
  upsertMeta("property", "og:title", title);
  upsertMeta("property", "og:description", description);
  upsertMeta("property", "og:url", url);
  upsertMeta("property", "og:image", image);
  upsertMeta("name", "twitter:card", "summary_large_image");
  upsertMeta("name", "twitter:title", title);
  upsertMeta("name", "twitter:description", description);
  upsertMeta("name", "twitter:image", image);
  upsertLink("canonical", url);
}

export function publicPageSeo(pathname: string): PageSeo | null {
  if (pathname === "/login") {
    return {
      title: `Sign in | ${SITE_NAME}`,
      description:
        "Sign in to ChasteBusinessOS, the open-source, AI-native business operating system for governed, auditable operations.",
      robots: "index,follow",
    };
  }
  if (pathname === "/reset-password") {
    return {
      title: `Reset password | ${SITE_NAME}`,
      description: "Reset your ChasteBusinessOS password.",
      robots: "noindex,nofollow",
    };
  }
  if (pathname === "/onboarding") {
    return {
      title: `Set up your workspace | ${SITE_NAME}`,
      description: "Set up a governed ChasteBusinessOS workspace.",
      robots: "noindex,nofollow",
    };
  }
  if (pathname.startsWith("/invite/")) {
    return {
      title: `Workspace invitation | ${SITE_NAME}`,
      description: "Accept your invitation to a ChasteBusinessOS workspace.",
      robots: "noindex,nofollow",
    };
  }
  if (pathname.startsWith("/portal/")) {
    return {
      title: `Invoice portal | ${SITE_NAME}`,
      description: "View and pay an invoice through the ChasteBusinessOS portal.",
      robots: "noindex,nofollow",
    };
  }
  if (pathname.startsWith("/widget/")) {
    return {
      title: `Customer chat | ${SITE_NAME}`,
      description: "Chat with the customer support desk.",
      robots: "noindex,nofollow",
    };
  }
  if (pathname.startsWith("/print/")) {
    return {
      title: `Invoice | ${SITE_NAME}`,
      description: "Printable business document.",
      robots: "noindex,nofollow",
    };
  }
  return null;
}

