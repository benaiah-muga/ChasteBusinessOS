import { describe, expect, it } from "vitest";
import {
  FIELD_SYNONYMS,
  REQUIRED_FIELDS,
  guessMapping,
  parseCsv,
} from "@/lib/csv";

/**
 * The CSV reader is the front door of the import wizard: everything a business
 * already has in a spreadsheet passes through it. A parser bug here does not
 * fail loudly, it writes the wrong thing — a name in the email column, a price
 * read as a unit, a quoted field split in half — so these tests pin the RFC
 * 4180 rules that protect the data rather than the happy path.
 *
 * Two deviations from RFC 4180 are deliberate and asserted as such below:
 * header and cell values are trimmed (RFC says spaces are data), and blank
 * lines are dropped. Both suit hand-made spreadsheets.
 */

describe("parseCsv — empty and degenerate input", () => {
  it("returns an empty table for an empty string", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
  });

  it("returns an empty table for whitespace and newlines only", () => {
    expect(parseCsv("\n\n")).toEqual({ headers: [], rows: [] });
    expect(parseCsv("   \n\t\n")).toEqual({ headers: [], rows: [] });
  });

  it("returns headers with no rows for a header-only file", () => {
    expect(parseCsv("name,email\n")).toEqual({ headers: ["name", "email"], rows: [] });
  });

  it("keeps the header row when the file has no trailing newline", () => {
    expect(parseCsv("name,email").headers).toEqual(["name", "email"]);
  });

  it("strips the UTF-8 BOM Excel writes, which would otherwise become part of the first header", () => {
    const table = parseCsv("\uFEFFname,email\nAda,ada@example.com\n");
    expect(table.headers).toEqual(["name", "email"]);
    expect(table.rows[0]).toEqual({ name: "Ada", email: "ada@example.com" });
  });
});

describe("parseCsv — the basic shape", () => {
  it("parses a simple table", () => {
    const table = parseCsv("name,email\nAda,ada@example.com\nAlan,alan@example.com\n");
    expect(table.headers).toEqual(["name", "email"]);
    expect(table.rows).toEqual([
      { name: "Ada", email: "ada@example.com" },
      { name: "Alan", email: "alan@example.com" },
    ]);
  });

  it("does not add a phantom row for a trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n").rows).toHaveLength(1);
  });

  it("keeps the last row when the file ends without a newline", () => {
    expect(parseCsv("a,b\n1,2").rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("drops blank lines anywhere in the file", () => {
    const table = parseCsv("a,b\n\n1,2\n\n\n3,4\n");
    expect(table.rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("drops lines holding only whitespace", () => {
    expect(parseCsv("a,b\n   \n1,2\n").rows).toEqual([{ a: "1", b: "2" }]);
  });
});

describe("parseCsv — line endings (RFC 4180 §2.1)", () => {
  it("handles CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n").rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("handles LF", () => {
    expect(parseCsv("a,b\n1,2\n").rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("handles bare CR, which old Mac exports still produce", () => {
    expect(parseCsv("a,b\r1,2\r").rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("does not split a row on the CR of a CRLF pair", () => {
    expect(parseCsv("a,b\r\n1,2\r\n").rows).toHaveLength(1);
  });
});

describe("parseCsv — quoting", () => {
  it("keeps a comma inside a quoted field instead of splitting on it", () => {
    const table = parseCsv('name,address\nAda,"Kampala, Uganda"\n');
    expect(table.rows[0]).toEqual({ name: "Ada", address: "Kampala, Uganda" });
  });

  it("keeps a newline inside a quoted field instead of ending the record", () => {
    const table = parseCsv('name,note\nAda,"line one\nline two"\n');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toEqual({ name: "Ada", note: "line one\nline two" });
  });

  it("keeps a CRLF inside a quoted field", () => {
    const table = parseCsv('name,note\r\nAda,"line one\r\nline two"\r\n');
    expect(table.rows[0]).toEqual({ name: "Ada", note: "line one\r\nline two" });
  });

  it("unescapes a doubled quote to one quote", () => {
    const table = parseCsv('name,quote\nAda,"she said ""hi"""\n');
    expect(table.rows[0]).toEqual({ name: "Ada", quote: 'she said "hi"' });
  });

  it("reads a quoted empty field as an empty string, not as a missing column", () => {
    const table = parseCsv('a,b,c\n1,"",3\n');
    expect(table.rows[0]).toEqual({ a: "1", b: "", c: "3" });
  });

  it("does not leave the surrounding quotes in the value", () => {
    expect(parseCsv('h\n"quoted"\n').rows[0]).toEqual({ h: "quoted" });
  });

  /* The rule that matters most for real catalogues: an inch mark in
     "6\" pipe" is data, not a quote the parser should open. */
  it("treats a quote in the middle of a field as literal data", () => {
    const table = parseCsv('sku,name\nPIPE-6,6" pipe\n');
    expect(table.rows[0]).toEqual({ sku: "PIPE-6", name: '6" pipe' });
  });

  it("treats a quote after text in a field as literal data", () => {
    expect(parseCsv("h\nab\"cd\n").rows[0]).toEqual({ h: 'ab"cd' });
  });

  it("survives an unterminated quote rather than losing the rest of the file", () => {
    const table = parseCsv('h\n"never closed\n');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.h).toBe("never closed");
  });
});

describe("parseCsv — ragged and duplicate columns (documented behaviour)", () => {
  it("fills missing trailing cells with empty strings", () => {
    const table = parseCsv("a,b,c\n1,2\n");
    expect(table.rows[0]).toEqual({ a: "1", b: "2", c: "" });
  });

  /* Extra cells are dropped, not invented a home for. The wizard only reads
     columns the mapping names, so this loses nothing on import — but it is
     loss, and it is pinned here so a future change has to say so out loud. */
  it("drops cells beyond the header count", () => {
    const table = parseCsv("a,b\n1,2,3\n");
    expect(table.rows[0]).toEqual({ a: "1", b: "2" });
    expect(Object.keys(table.rows[0]!)).toEqual(["a", "b"]);
  });

  it("lets the last column win when two headers share a name", () => {
    const table = parseCsv("a,a\n1,2\n");
    expect(table.rows[0]).toEqual({ a: "2" });
  });
});

describe("parseCsv — trimming (deliberate deviation from RFC 4180 §2.7)", () => {
  it("trims headers", () => {
    expect(parseCsv("  Name , Email \n1,2\n").headers).toEqual(["Name", "Email"]);
  });

  it("trims values", () => {
    expect(parseCsv("a,b\n  1  ,  2  \n").rows[0]).toEqual({ a: "1", b: "2" });
  });

  it("trims inside quoted fields too, which RFC 4180 would preserve", () => {
    expect(parseCsv('h\n"  padded  "\n').rows[0]).toEqual({ h: "padded" });
  });
});

describe("parseCsv — content fidelity", () => {
  it("preserves non-ASCII text", () => {
    const table = parseCsv('name,note\nJosé,"café ☕"\n');
    expect(table.rows[0]).toEqual({ name: "José", note: "café ☕" });
  });

  it("preserves numbers as strings so leading zeros survive", () => {
    const table = parseCsv("code\n00742\n");
    expect(table.rows[0]).toEqual({ code: "00742" });
  });

  it("preserves a value that looks like a negative amount", () => {
    expect(parseCsv("amount\n-1250.50\n").rows[0]).toEqual({ amount: "-1250.50" });
  });
});

describe("guessMapping — exact matching wins", () => {
  it("prefers an exact header over one that merely contains the word", () => {
    const mapping = guessMapping("customers", ["Email (work)", "Email"]);
    expect(mapping.email).toBe("Email");
  });

  it("normalises case, underscores and dashes before comparing", () => {
    const mapping = guessMapping("customers", ["Name", "E_MAIL"]);
    expect(mapping.name).toBe("Name");
    expect(mapping.email).toBe("E_MAIL");
  });

  it("matches a spelled-out synonym", () => {
    const mapping = guessMapping("products", ["Item Code", "Item Name", "Unit Price"]);
    expect(mapping.sku).toBe("Item Code");
    expect(mapping.name).toBe("Item Name");
  });

  it("returns null for a field nothing resembles, so the UI asks instead of guessing", () => {
    const mapping = guessMapping("customers", ["frobnicate"]);
    expect(mapping).toEqual({ name: null, email: null, creditLimit: null, paymentTermDays: null });
  });
});

describe("guessMapping — column assignment", () => {
  /* The bug this guards: `unitLabel` is declared before `salePrice`, so a
     substring pass run per-field let "unit" claim "Unit Price" and left the
     price unmapped. The price column is the one that cannot be wrong. */
  it("maps a 'Unit Price' column to the price, not to the unit label", () => {
    const mapping = guessMapping("products", ["Item Code", "Item Name", "Unit Price"]);
    expect(mapping.salePrice).toBe("Unit Price");
    expect(mapping.unitLabel).toBeNull();
  });

  it("prefers the longest synonym when two fields could claim a column", () => {
    const mapping = guessMapping("products", ["Unit of Measure"]);
    expect(mapping.unitLabel).toBe("Unit of Measure");
    expect(mapping.salePrice).toBeNull();
  });

  it("never assigns one column to two fields", () => {
    const headers = ["Name", "Product Name", "Price", "SKU Code"];
    const mapping = guessMapping("products", headers);
    const used = Object.values(mapping).filter((v): v is string => v !== null);
    expect(new Set(used).size).toBe(used.length);
  });

  it("leaves a field unmatched rather than stealing a column another field matched exactly", () => {
    const mapping = guessMapping("products", ["Unit Price"]);
    expect(mapping.salePrice).toBe("Unit Price");
    expect(mapping.unitLabel).toBeNull();
  });
});

describe("guessMapping — short synonyms are exact-only", () => {
  /* "id" lives inside "paid"; "ean" inside "cleaner". Letting two- and
     three-letter synonyms match on substring imports columns nobody chose. */
  it("does not read a 'Paid' column as the SKU", () => {
    const mapping = guessMapping("products", ["Paid", "Description"]);
    expect(mapping.sku).toBeNull();
    expect(mapping.name).toBe("Description");
  });

  it("does not read a 'Cleaner' column as the barcode", () => {
    const mapping = guessMapping("products", ["Cleaner", "Product"]);
    expect(mapping.barcode).toBeNull();
  });

  it("still matches a short synonym exactly", () => {
    const mapping = guessMapping("products", ["id", "name"]);
    expect(mapping.sku).toBe("id");
  });
});

describe("guessMapping — realistic spreadsheets", () => {
  it("maps every required customer field from a typical export", () => {
    const headers = ["Customer Name", "Email Address", "Credit Limit", "Payment Terms"];
    const mapping = guessMapping("customers", headers);
    for (const field of REQUIRED_FIELDS.customers) {
      expect(mapping[field], `${field} should be mapped`).not.toBeNull();
    }
    expect(mapping.email).toBe("Email Address");
    expect(mapping.creditLimit).toBe("Credit Limit");
    expect(mapping.paymentTermDays).toBe("Payment Terms");
  });

  it("maps every required product field from a typical export", () => {
    const headers = ["SKU", "Product Name", "Unit", "Sale Price", "Barcode"];
    const mapping = guessMapping("products", headers);
    for (const field of REQUIRED_FIELDS.products) {
      expect(mapping[field], `${field} should be mapped`).not.toBeNull();
    }
    expect(mapping.sku).toBe("SKU");
    expect(mapping.name).toBe("Product Name");
    expect(mapping.unitLabel).toBe("Unit");
    expect(mapping.salePrice).toBe("Sale Price");
    expect(mapping.barcode).toBe("Barcode");
  });

  it("covers every declared field for both entities", () => {
    for (const entity of ["customers", "products"] as const) {
      const mapping = guessMapping(entity, []);
      expect(Object.keys(mapping).sort()).toEqual(Object.keys(FIELD_SYNONYMS[entity]).sort());
    }
  });
});

describe("parseCsv and guessMapping together", () => {
  it("reads an end-to-end products import with quoted commas and CRLF", () => {
    const text = 'SKU,Product Name,Unit Price\r\nA-1,"Bolt, 6mm",0.45\r\nA-2,"Nut, 6mm",0.15\r\n';
    const table = parseCsv(text);
    const mapping = guessMapping("products", table.headers);
    expect(table.rows).toHaveLength(2);
    expect(mapping.sku).toBe("SKU");
    expect(mapping.salePrice).toBe("Unit Price");
    expect(table.rows[0]?.[mapping.name!]).toBe("Bolt, 6mm");
    expect(table.rows[0]?.[mapping.salePrice!]).toBe("0.45");
  });
});
