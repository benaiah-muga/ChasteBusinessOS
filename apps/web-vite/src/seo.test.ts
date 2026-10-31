import { afterEach, describe, expect, it } from "vitest";
import { applyPageSeo, publicPageSeo } from "./seo";

afterEach(() => {
  document.head
    .querySelectorAll(
      'meta[name="description"], meta[name="robots"], meta[property^="og:"], meta[name^="twitter:"], link[rel="canonical"]',
    )
    .forEach((element) => element.remove());
  window.history.replaceState({}, "", "/");
});

describe("public page SEO", () => {
  it("marks the sign-in page indexable and the workspace private", () => {
    expect(publicPageSeo("/login")).toMatchObject({
      robots: "index,follow",
    });
    expect(publicPageSeo("/accounting")).toBeNull();
    expect(publicPageSeo("/portal/inv_123")).toMatchObject({
      robots: "noindex,nofollow",
    });
  });

  it("writes canonical, robots, Open Graph, and Twitter metadata", () => {
    window.history.replaceState({}, "", "/login");
    applyPageSeo({
      title: "Sign in | ChasteBusinessOS",
      description: "Governed business operations.",
      robots: "index,follow",
    });

    expect(document.title).toBe("Sign in | ChasteBusinessOS");
    expect(
      document.head.querySelector('meta[name="robots"]')?.getAttribute("content"),
    ).toBe("index,follow");
    expect(
      document.head.querySelector('meta[property="og:title"]')?.getAttribute("content"),
    ).toBe("Sign in | ChasteBusinessOS");
    expect(
      document.head.querySelector('meta[name="twitter:card"]')?.getAttribute("content"),
    ).toBe("summary_large_image");
    expect(
      document.head.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    ).toBe(`${window.location.origin}/login`);
  });
});
