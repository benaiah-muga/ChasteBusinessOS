import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductsPage } from "./ProductsPage";

const api = vi.hoisted(() => ({
  fetchProducts: vi.fn(),
  fetchProductsEnabled: vi.fn(),
  fetchProductDefaults: vi.fn(),
  importProducts: vi.fn(),
  recoverProductImport: vi.fn(),
  submitProductAction: vi.fn(),
  undoProductImport: vi.fn(),
  restoreProductImport: vi.fn(),
}));

vi.mock("../api/products", () => ({
  fetchProducts: api.fetchProducts,
  fetchProductsEnabled: api.fetchProductsEnabled,
  fetchProductDefaults: api.fetchProductDefaults,
  importProducts: api.importProducts,
  recoverProductImport: api.recoverProductImport,
  submitProductAction: api.submitProductAction,
  undoProductImport: api.undoProductImport,
  restoreProductImport: api.restoreProductImport,
  ProductsApiError: class ProductsApiError extends Error {},
}));

const product = {
  sku: "MUG-1", name: "Ceramic mug", kind: "goods" as const, unitLabel: "unit", salePriceMinor: 1250,
  imageUrl: null, tags: ["Kitchen"], barcode: "123456", onHandThousandths: 2000, valueMinor: 800,
  avgUnitCostMinor: 400, reorderPointThousandths: 1000, reorderNeeded: false,
};

function deferred() {
  let resolve: ((value: unknown) => void) | undefined;
  const promise = new Promise<unknown>((complete) => { resolve = complete; });
  return { promise, resolve: (value: unknown) => resolve?.(value) };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  api.fetchProductsEnabled.mockResolvedValue(true);
  api.fetchProductDefaults.mockResolvedValue({});
  api.recoverProductImport.mockResolvedValue({ pendingRows: null, pendingUndoIds: null, pendingRestoreIds: null, recovery: null });
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

  it("drops the previous organization's catalog and ignores its delayed response", async () => {
    let resolveOldCatalog: ((value: { items: typeof product[]; reorderAlerts: []; totalValueMinor: number }) => void) | undefined;
    const oldCatalog = new Promise<{ items: typeof product[]; reorderAlerts: []; totalValueMinor: number }>((resolve) => { resolveOldCatalog = resolve; });
    api.fetchProducts.mockReturnValueOnce(oldCatalog).mockResolvedValueOnce({
      items: [{ ...product, sku: "NEW-ORG", name: "New organization item" }],
      reorderAlerts: [],
      totalValueMinor: 0,
    });
    const { rerender } = render(<ProductsPage actorId="actor-a" organizationId="org-a" />);
    await waitFor(() => expect(api.fetchProducts).toHaveBeenCalledTimes(1));

    rerender(<ProductsPage actorId="actor-a" organizationId="org-b" />);
    fireEvent.click(await screen.findByRole("button", { name: "Products & Services" }));
    expect(await screen.findByText("New organization item")).toBeTruthy();
    resolveOldCatalog?.({ items: [{ ...product, sku: "OLD-ORG", name: "Old organization item" }], reorderAlerts: [], totalValueMinor: 800 });
    await waitFor(() => expect(screen.queryByText("Old organization item")).toBeNull());
  });

  it.each(["action", "import", "undo", "restore"] as const)("ignores a delayed %s result after the organization changes", async (operation) => {
    const actorId = "10000000-0000-4000-8000-000000000010";
    const organizationId = "10000000-0000-4000-8000-000000000011";
    const itemId = "10000000-0000-4000-8000-000000000021";
    const pending = deferred();
    api.fetchProducts.mockResolvedValue({ items: [], reorderAlerts: [], totalValueMinor: 0 });
    api.recoverProductImport.mockResolvedValueOnce({
      pendingRows: null,
      pendingUndoIds: null,
      pendingRestoreIds: null,
      recovery: operation === "undo" || operation === "restore" ? {
        result: { inserted: 1, skippedDuplicates: 0, errors: [], createdIds: [itemId], undone: operation === "restore" },
        activeIds: operation === "undo" ? [itemId] : [],
        archivedIds: operation === "restore" ? [itemId] : [],
      } : null,
    }).mockResolvedValue({ pendingRows: null, pendingUndoIds: null, pendingRestoreIds: null, recovery: null });
    if (operation === "action") api.submitProductAction.mockReturnValueOnce(pending.promise);
    if (operation === "import") api.importProducts.mockReturnValueOnce(pending.promise);
    if (operation === "undo") api.undoProductImport.mockReturnValueOnce(pending.promise);
    if (operation === "restore") api.restoreProductImport.mockReturnValueOnce(pending.promise);

    const { rerender } = render(<ProductsPage actorId={actorId} organizationId={organizationId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Products & Services" }));
    if (operation === "action") {
      fireEvent.click(screen.getByRole("button", { name: "Add item" }));
      fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Scope race item" } });
      fireEvent.change(screen.getByLabelText("SKU"), { target: { value: "SCOPE-RACE" } });
      fireEvent.click(screen.getByRole("button", { name: "Add product" }));
    } else if (operation === "import") {
      const csv = "sku,name,kind,unit,salePrice\nRACE-1,Race item,goods,unit,2.50";
      const file = new File([csv], "catalog.csv", { type: "text/csv" });
      Object.defineProperty(file, "text", { configurable: true, value: async () => csv });
      fireEvent.change(screen.getByLabelText("Choose products CSV file"), { target: { files: [file] } });
      fireEvent.click(await screen.findByRole("button", { name: "Import rows" }));
    } else {
      const buttonName = operation === "undo" ? "Undo import" : "Restore import";
      fireEvent.click(await screen.findByRole("button", { name: buttonName }));
    }

    await waitFor(() => expect(operation === "action" ? api.submitProductAction : operation === "import" ? api.importProducts : operation === "undo" ? api.undoProductImport : api.restoreProductImport).toHaveBeenCalledTimes(1));
    rerender(<ProductsPage actorId={actorId} organizationId="10000000-0000-4000-8000-000000000012" />);
    await waitFor(() => expect(api.fetchProducts).toHaveBeenCalledTimes(2));

    const result = operation === "action" ? { kind: "completed" }
      : operation === "import" ? { inserted: 1, skippedDuplicates: 0, errors: [], createdIds: [itemId] }
        : operation === "undo" ? { kind: "completed", undone: 1, remaining: 0, itemIds: [itemId] }
          : { kind: "completed", restored: 1, itemIds: [itemId] };
    await act(async () => { pending.resolve(result); });
    await waitFor(() => expect(api.fetchProducts).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/completed\.|imported,|Undid the import|Restored/)).toBeNull();
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
    }), { actorId: null, organizationId: null }));
  });

  it("uses the organization currency exponent for product prices", async () => {
    api.fetchProducts.mockResolvedValue({ items: [], reorderAlerts: [], totalValueMinor: 0 });
    api.submitProductAction.mockResolvedValue({ kind: "completed" });
    render(<ProductsPage baseCurrency="JPY" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }));
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "service" } });
    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Consultation" } });
    fireEvent.change(screen.getByLabelText("SKU"), { target: { value: "CONSULT-JPY" } });
    fireEvent.change(screen.getByLabelText("Sale price"), { target: { value: "7550" } });
    expect(screen.getByLabelText("Sale price")).toHaveProperty("step", "1");
    fireEvent.click(screen.getByRole("button", { name: "Add service" }));
    await waitFor(() => expect(api.submitProductAction).toHaveBeenCalledWith(expect.objectContaining({ salePriceMinor: 7550 }), { actorId: null, organizationId: null }));
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
    await waitFor(() => expect(api.submitProductAction).toHaveBeenCalledWith(expect.objectContaining({ action: "updateItem", sku: "MUG-1", name: "Cup" }), { actorId: null, organizationId: null }));
    const row = screen.getByRole("row", { name: /MUG-1/ });
    fireEvent.click(within(row).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(api.submitProductAction).toHaveBeenCalledWith({ action: "archiveItem", sku: "MUG-1", archive: true }, { actorId: null, organizationId: null }));
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
    const actorId = "10000000-0000-4000-8000-000000000010";
    const organizationId = "10000000-0000-4000-8000-000000000011";
    api.fetchProducts.mockResolvedValue({ items: [], reorderAlerts: [], totalValueMinor: 0 });
    api.importProducts.mockResolvedValue({ inserted: 1, skippedDuplicates: 0, errors: [], createdIds: ["10000000-0000-4000-8000-000000000001"] });
    render(<ProductsPage actorId={actorId} organizationId={organizationId} />);
    const csv = `sku,name,kind,unit,salePrice,tags\nSOAP-1,Hand soap,goods,${"b".repeat(21)},3.25,Home\nSOAP-2,Hand soap,goods,bottle,3.25,Home`;
    const file = new File([csv], "catalog.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { configurable: true, value: async () => csv });
    fireEvent.change(await screen.findByLabelText("Choose products CSV file"), { target: { files: [file] } });
    expect(await screen.findByText("1 valid rows, 1 row errors")).toBeTruthy();
    expect(screen.getByText(/Row 2: Unit labels must be 20 characters or fewer/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Import rows" }));
    await waitFor(() => expect(api.importProducts).toHaveBeenCalledWith([expect.objectContaining({ sku: "SOAP-2", salePrice: "3.25", tags: ["Home"] })], undefined, { actorId, organizationId }, "USD"));
  });

  it.each([
    { currency: "BHD", validPrice: "1.234", extraPrecisionPrice: "1.2345", decimals: 3 },
    { currency: "JPY", validPrice: "7550", extraPrecisionPrice: "7550.1", decimals: 0 },
  ])("validates CSV prices with the $currency minor-unit precision", async ({ currency, validPrice, extraPrecisionPrice, decimals }) => {
    const actorId = "10000000-0000-4000-8000-000000000010";
    const organizationId = "10000000-0000-4000-8000-000000000011";
    api.fetchProducts.mockResolvedValue({ items: [], reorderAlerts: [], totalValueMinor: 0 });
    api.importProducts.mockResolvedValue({ inserted: 1, skippedDuplicates: 0, errors: [], createdIds: ["10000000-0000-4000-8000-000000000001"] });
    render(<ProductsPage baseCurrency={currency} actorId={actorId} organizationId={organizationId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Products & Services" }));
    const csv = `sku,name,kind,unit,salePrice\nVALID-${currency},Valid item,goods,unit,${validPrice}\nINVALID-${currency},Extra precision item,goods,unit,${extraPrecisionPrice}`;
    const file = new File([csv], "catalog.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { configurable: true, value: async () => csv });
    fireEvent.change(screen.getByLabelText("Choose products CSV file"), { target: { files: [file] } });

    expect(await screen.findByText("1 valid rows, 1 row errors")).toBeTruthy();
    expect(screen.getByText(`Row 3: Sale price must be non-negative with at most ${decimals} decimals.`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import rows" }));
    await waitFor(() => expect(api.importProducts).toHaveBeenCalledWith([
      expect.objectContaining({ sku: `VALID-${currency}`, salePrice: validPrice }),
    ], undefined, { actorId, organizationId }, currency));
    expect(api.importProducts.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it("shows scoped import, undo, and restore recovery controls after remount", async () => {
    const actorId = "10000000-0000-4000-8000-000000000010";
    const organizationId = "10000000-0000-4000-8000-000000000011";
    const itemId = "10000000-0000-4000-8000-000000000021";
    api.fetchProducts.mockResolvedValue({ items: [], reorderAlerts: [], totalValueMinor: 0 });
    api.recoverProductImport.mockResolvedValue({
      pendingRows: [{ rowNumber: 2, name: "Tea", sku: "TEA-1", type: "goods", salePrice: "3.25", tags: [] }],
      pendingUndoIds: [itemId],
      pendingRestoreIds: null,
      recovery: { result: { inserted: 1, skippedDuplicates: 0, errors: [], createdIds: [itemId] }, activeIds: [itemId], archivedIds: [] },
    });
    api.importProducts.mockResolvedValue({ inserted: 1, skippedDuplicates: 0, errors: [], createdIds: [itemId] });
    api.undoProductImport.mockResolvedValue({ kind: "completed", undone: 1, remaining: 0, itemIds: [itemId] });
    render(<ProductsPage actorId={actorId} organizationId={organizationId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Products & Services" }));

    expect(await screen.findByRole("button", { name: "Retry pending import" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry pending undo" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry pending import" }));
    await waitFor(() => expect(api.importProducts).toHaveBeenCalledWith(
      [{ rowNumber: 2, name: "Tea", sku: "TEA-1", type: "goods", salePrice: "3.25", tags: [] }],
      undefined,
      { actorId, organizationId },
      "USD",
    ));
    fireEvent.click(screen.getByRole("button", { name: "Retry pending undo" }));
    await waitFor(() => expect(api.undoProductImport).toHaveBeenCalledWith([itemId], undefined, { actorId, organizationId }));
  });
});
