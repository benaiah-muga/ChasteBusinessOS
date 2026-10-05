import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductsPage } from "./ProductsPage";

const api = vi.hoisted(() => ({
  fetchProducts: vi.fn(),
  fetchProductsEnabled: vi.fn(),
  fetchProductDefaults: vi.fn(),
  importProducts: vi.fn(),
  submitProductAction: vi.fn(),
  undoProductImport: vi.fn(),
}));

vi.mock("../api/products", () => ({
  fetchProducts: api.fetchProducts,
  fetchProductsEnabled: api.fetchProductsEnabled,
  fetchProductDefaults: api.fetchProductDefaults,
  importProducts: api.importProducts,
  submitProductAction: api.submitProductAction,
  undoProductImport: api.undoProductImport,
  ProductsApiError: class ProductsApiError extends Error {},
}));

const product = {
  sku: "MUG-1", name: "Ceramic mug", kind: "goods" as const, unitLabel: "unit", salePriceMinor: 1250,
  imageUrl: null, tags: ["Kitchen"], barcode: "123456", onHandThousandths: 2000, valueMinor: 800,
  avgUnitCostMinor: 400, reorderPointThousandths: 1000, reorderNeeded: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

beforeEach(() => {
  api.fetchProductsEnabled.mockResolvedValue(true);
  api.fetchProductDefaults.mockResolvedValue({});
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute("open", ""); };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  }
});

describe("ProductsPage", () => {
  it("filters the catalog by type, category, stock, and search", async () => {
    api.fetchProducts.mockResolvedValue({ items: [product, { ...product, sku: "CONSULT", name: "Consulting", kind: "service", tags: ["Professional"], reorderNeeded: true, onHandThousandths: 0 }], reorderAlerts: [], totalValueMinor: 800 });
    render(<ProductsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Products & Services" }));
    expect(await screen.findByText("Ceramic mug")).toBeTruthy();
    expect(screen.getByText("Consulting")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by category" }), { target: { value: "Kitchen" } });
    expect(screen.getByText("Ceramic mug")).toBeTruthy();
    expect(screen.queryByText("Consulting")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by category" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by stock status" }), { target: { value: "reorder" } });
    expect(screen.getByText("Consulting")).toBeTruthy();
    expect(screen.queryByText("Ceramic mug")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by stock status" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by item type" }), { target: { value: "service" } });
    expect(screen.queryByText("Ceramic mug")).toBeNull();
    expect(screen.getByText("Consulting")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search catalog" }), { target: { value: "absent" } });
    expect(screen.getByText("No items match these filters.")).toBeTruthy();
  });

  it("creates service metadata through the governed action API", async () => {
    api.fetchProducts.mockResolvedValue({ items: [], reorderAlerts: [], totalValueMinor: 0 });
    api.submitProductAction.mockResolvedValue({ kind: "completed" });
    render(<ProductsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }));
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "service" } });
    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Consultation" } });
    fireEvent.change(screen.getByLabelText("SKU"), { target: { value: "CONSULT-HR" } });
    fireEvent.change(screen.getByLabelText("Billing unit"), { target: { value: "hour" } });
    fireEvent.change(screen.getByLabelText("Sale price"), { target: { value: "75.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Add service" }));
    await waitFor(() => expect(api.submitProductAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "createItem", sku: "CONSULT-HR", name: "Consultation", kind: "service", unitLabel: "hour", salePriceMinor: 7550,
    })));
  });

  it("prefills the create form with inventory module defaults", async () => {
    api.fetchProducts.mockResolvedValue({ items: [], reorderAlerts: [], totalValueMinor: 0 });
    api.fetchProductDefaults.mockResolvedValue({ defaultUnitLabel: "carton", defaultReorderPointUnits: 12 });
    render(<ProductsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }));
    await waitFor(() => {
      expect((screen.getByLabelText("Unit label") as HTMLInputElement).value).toBe("carton");
      expect((screen.getByLabelText("Reorder point") as HTMLInputElement).value).toBe("12");
    });
  });

  it("edits and archives a catalog item through governed actions", async () => {
    api.fetchProducts.mockResolvedValue({ items: [product], reorderAlerts: [], totalValueMinor: 800 });
    api.submitProductAction.mockResolvedValue({ kind: "completed" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ProductsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Products & Services" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Edit MUG-1" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Cup" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.submitProductAction).toHaveBeenCalledWith(expect.objectContaining({ action: "updateItem", sku: "MUG-1", name: "Cup" })));
    const row = screen.getByRole("row", { name: /MUG-1/ });
    fireEvent.click(within(row).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(api.submitProductAction).toHaveBeenCalledWith({ action: "archiveItem", sku: "MUG-1", archive: true }));
  });

  it("keeps the create form and reports approval pending", async () => {
    api.fetchProducts.mockResolvedValue({ items: [], reorderAlerts: [], totalValueMinor: 0 });
    api.submitProductAction.mockResolvedValue({ kind: "pending", reason: "Manager review" });
    render(<ProductsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }));
    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Tea" } });
    fireEvent.change(screen.getByLabelText("SKU"), { target: { value: "TEA-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add product" }));
    expect((await screen.findByRole("status")).textContent).toContain("requires approval");
    expect((screen.getByLabelText("Product name") as HTMLInputElement).value).toBe("Tea");
  });

  it("previews a CSV and imports its rows through the governed endpoint", async () => {
    api.fetchProducts.mockResolvedValue({ items: [], reorderAlerts: [], totalValueMinor: 0 });
    api.importProducts.mockResolvedValue({ inserted: 1, skippedDuplicates: 0, errors: [], createdIds: ["10000000-0000-4000-8000-000000000001"] });
    render(<ProductsPage />);
    const csv = `sku,name,kind,unit,salePrice,tags\nSOAP-1,Hand soap,goods,${"b".repeat(21)},3.25,Home\nSOAP-2,Hand soap,goods,bottle,3.25,Home`;
    const file = new File([csv], "catalog.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { configurable: true, value: async () => csv });
    fireEvent.change(await screen.findByLabelText("Choose products CSV file"), { target: { files: [file] } });
    expect(await screen.findByText("1 valid rows, 1 row errors")).toBeTruthy();
    expect(screen.getByText(/Row 2: Unit labels must be 20 characters or fewer/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Import rows" }));
    await waitFor(() => expect(api.importProducts).toHaveBeenCalledWith([expect.objectContaining({ sku: "SOAP-2", salePrice: "3.25", tags: ["Home"] })]));
  });
});
