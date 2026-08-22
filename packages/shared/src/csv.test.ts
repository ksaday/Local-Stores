import { describe, expect, it } from "vitest";
import { csvCell, csvMoney, escapeCsvCell, toCsv } from "./csv.js";

describe("csv cells", () => {
  it("leaves an ordinary value alone", () => {
    expect(escapeCsvCell("Sourdough")).toBe("Sourdough");
  });

  it("quotes the three things that break a naive join", () => {
    // Each of these is a real value a shop has typed at some point.
    expect(escapeCsvCell("Bread, sliced")).toBe('"Bread, sliced"');
    expect(escapeCsvCell('The "good" one')).toBe('"The ""good"" one"');
    expect(escapeCsvCell("Two\nlines")).toBe('"Two\nlines"');
  });

  it("writes nothing for a missing value, not the word null", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("writes money as a number a spreadsheet will add up", () => {
    // No symbol and no separators: either turns the column into text, and the
    // first thing anybody does with the figures is sum them.
    expect(csvMoney(123_456)).toBe("1234.56");
    expect(csvMoney(0)).toBe("0.00");
    expect(csvMoney(5)).toBe("0.05");
  });

  it("ends every line, including the last", () => {
    const out = toCsv(["a", "b"], [["1", "2"]]);
    expect(out).toBe("a,b\r\n1,2\r\n");
  });

  it("escapes the header too", () => {
    expect(toCsv(["Lifetime spend, net"], [])).toBe('"Lifetime spend, net"\r\n');
  });
});
