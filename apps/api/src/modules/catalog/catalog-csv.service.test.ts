import { describe, expect, it } from "vitest";
import { parseCsv, parseMoney } from "./catalog-csv.service.js";

/**
 * The parser and the money reader are pure, and they are where a real file
 * from a real shop goes wrong. Tested directly rather than through an import,
 * so a failure names the actual defect.
 */

describe("reading a price the way a person writes one", () => {
  it("reads plain decimals", () => {
    expect(parseMoney("12.50")).toBe(1250);
    expect(parseMoney("12.5")).toBe(1250);
    expect(parseMoney("12")).toBe(1200);
  });

  it("tolerates currency symbols and thousands separators", () => {
    // A shop's own spreadsheet is formatted for people, not for us.
    expect(parseMoney("$12.50")).toBe(1250);
    expect(parseMoney("£9.99")).toBe(999);
    expect(parseMoney("1,234.56")).toBe(123456);
    expect(parseMoney(" 12.50 ")).toBe(1250);
  });

  it("refuses an empty cell rather than reading it as free", () => {
    // `Number("")` is 0, which would silently put a product on sale for
    // nothing. The whole reason this returns null.
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("   ")).toBeNull();
  });

  it("refuses text rather than storing NaN", () => {
    expect(parseMoney("call for price")).toBeNull();
    expect(parseMoney("12.5.0")).toBeNull();
    expect(parseMoney("-5.00")).toBeNull();
  });

  it("refuses more precision than money has", () => {
    // Three decimals means the file is not a price list, or the owner has
    // made a mistake worth telling them about.
    expect(parseMoney("12.505")).toBeNull();
  });
});

describe("parsing CSV a spreadsheet actually produces", () => {
  it("reads a simple file", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps commas inside quoted cells", () => {
    // The first product description with a comma in it breaks a naive split,
    // and shifts every column after it.
    expect(parseCsv('name,description\nLoaf,"Sourdough, 48-hour ferment"')).toEqual([
      ["name", "description"],
      ["Loaf", "Sourdough, 48-hour ferment"],
    ]);
  });

  it("reads a doubled quote as a literal quote", () => {
    expect(parseCsv('name\n"The ""Big"" Loaf"')).toEqual([["name"], ['The "Big" Loaf']]);
  });

  it("keeps newlines inside quoted cells", () => {
    const rows = parseCsv('name,description\nLoaf,"Line one\nLine two"');
    expect(rows).toHaveLength(2);
    expect(rows[1]![1]).toBe("Line one\nLine two");
  });

  it("handles the CRLF that Excel writes", () => {
    // Without this every last cell carries a trailing \r, so "ACTIVE" matches
    // nothing and every status silently falls through to a default.
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles a file that does not end in a newline", () => {
    expect(parseCsv("a,b\n1,2")).toHaveLength(2);
  });

  it("keeps empty cells rather than collapsing the row", () => {
    // A blank brand must not shift price into the brand column.
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("survives a quoted cell containing a comma at the end of a line", () => {
    const rows = parseCsv('a,b\n1,"x,y"\n2,z');
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "x,y"],
      ["2", "z"],
    ]);
  });
});
