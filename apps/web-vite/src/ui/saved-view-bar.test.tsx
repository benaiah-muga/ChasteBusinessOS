import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SavedViewBar } from "./saved-view-bar";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SavedViewBar", () => {
  it("saves, applies, and removes a view for the active organization", () => {
    const onApply = vi.fn();
    render(<SavedViewBar module="invoices" organizationId="org-1" current={{ status: "open", query: "acme" }} onApply={onApply} />);

    fireEvent.click(screen.getByRole("button", { name: /Save view/ }));
    fireEvent.change(screen.getByLabelText("Saved view name"), { target: { value: "Acme open" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getAllByRole("button", { name: /Acme open/ }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: /Acme open/ })[0]!);
    expect(onApply).toHaveBeenCalledWith({ status: "open", query: "acme" });

    fireEvent.click(screen.getByRole("button", { name: "Delete saved view Acme open" }));
    expect(screen.queryAllByRole("button", { name: /Acme open/ })).toHaveLength(0);
  });

  it("does not leak a view into another organization", () => {
    const { rerender } = render(<SavedViewBar module="invoices" organizationId="org-1" current={{ status: "open" }} onApply={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Save view/ }));
    fireEvent.change(screen.getByLabelText("Saved view name"), { target: { value: "Org one" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    rerender(<SavedViewBar module="invoices" organizationId="org-2" current={{ status: "open" }} onApply={() => undefined} />);
    expect(screen.queryByRole("button", { name: /Org one/ })).toBeNull();
  });
});
