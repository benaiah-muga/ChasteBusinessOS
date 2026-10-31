import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatCard, ChatCardKind } from "../api/chat";
import { CARD_KIND_LABEL, EVIDENCE_MAX_CHARS, WorkmateRecordCard } from "./WorkmateRecordCard";

const KINDS: Array<[ChatCardKind, string]> = [
  ["exception", "Exception"],
  ["progress", "Progress"],
  ["waiting", "Waiting"],
  ["result", "Result"],
];

function record(overrides: Partial<ChatCard> = {}): ChatCard {
  return {
    kind: "exception",
    title: "CEM-1 below reorder point",
    status: "open",
    summary: "Available stock is below the reorder point.",
    next: "Prepare a purchase proposal",
    evidence: { sku: "CEM-1", available: 5000 },
    ...overrides,
  };
}

afterEach(cleanup);

describe("WorkmateRecordCard", () => {
  it.each(KINDS)("renders the %s kind with its record fields", (kind, label) => {
    render(<WorkmateRecordCard card={record({ kind })} />);

    const region = screen.getByRole("region", { name: `${label} record: CEM-1 below reorder point` });
    expect(region.className).toContain(`workmate-record-card-${kind}`);
    expect(CARD_KIND_LABEL[kind]).toBe(label);
    expect(within(region).getByText(label)).not.toBeNull();
    expect(within(region).getByRole("heading", { name: "CEM-1 below reorder point", level: 3 })).not.toBeNull();
    expect(within(region).getByText("open")).not.toBeNull();
    expect(within(region).getByText("Available stock is below the reorder point.")).not.toBeNull();
    expect(within(region).getByText("Next")).not.toBeNull();
    expect(within(region).getByText("Prepare a purchase proposal")).not.toBeNull();
    expect(within(region).getByText(/sku: CEM-1/)).not.toBeNull();
    expect(within(region).getByText(/available: 5000/)).not.toBeNull();
    // A record view only: no approval or mutation affordances.
    expect(within(region).queryByRole("button")).toBeNull();
  });

  it("shows exception severity as text and omits it when absent", () => {
    const { unmount } = render(<WorkmateRecordCard card={record({ severity: "high" })} />);
    expect(screen.getByText("Severity")).not.toBeNull();
    expect(screen.getByText("high")).not.toBeNull();
    unmount();

    render(<WorkmateRecordCard card={record()} />);
    expect(screen.queryByText("Severity")).toBeNull();
  });

  it("truncates long evidence to the visible character cap", () => {
    const longNote = "stock-check ".repeat(120);
    render(<WorkmateRecordCard card={record({ evidence: { note: longNote } })} />);

    const evidence = screen.getByLabelText("Evidence for CEM-1 below reorder point");
    const text = evidence.textContent ?? "";
    expect(text.length).toBe(EVIDENCE_MAX_CHARS);
    expect(text.endsWith("\u2026")).toBe(true);
    expect(text).not.toContain(longNote);
  });

  it("keeps nested evidence readable as bounded JSON", () => {
    render(<WorkmateRecordCard card={record({ evidence: { lines: [{ sku: "CEM-1", available: 5000 }] } })} />);

    const evidence = screen.getByLabelText("Evidence for CEM-1 below reorder point");
    expect(evidence.tagName).toBe("PRE");
    expect(evidence.textContent).toContain('"sku": "CEM-1"');
  });
});
