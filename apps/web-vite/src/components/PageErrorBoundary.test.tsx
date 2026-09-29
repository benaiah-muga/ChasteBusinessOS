import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageErrorBoundary } from "./PageErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PageErrorBoundary", () => {
  it("keeps page failures inside the workspace shell and offers reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function BrokenPage(): never {
      throw new Error("The preview chunk could not load.");
    }

    render(<PageErrorBoundary><BrokenPage /></PageErrorBoundary>);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Could not load this page." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
  });
});
