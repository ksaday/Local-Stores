/**
 * RFC 4180 CSV writing.
 *
 * Hand-written rather than a dependency for the same reason the *parser* in
 * the catalog module is: the shape is small and fully specified, and the
 * failure modes that matter — a comma inside a product name, a quote inside a
 * customer's name, a newline in a note — are exactly the ones a naive
 * `join(",")` gets wrong on the first real file a shop exports.
 *
 * Here rather than in a module because three of them now need it: the catalog
 * already had a private copy, and the report exports would have been a fourth.
 */

/** Quotes a cell only when it needs it, doubling any quotes inside. */
export function escapeCsvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * A cell for a spreadsheet, from whatever the row actually holds.
 *
 * `null` and `undefined` become empty rather than the words "null" and
 * "undefined", which is what a `${}` template would put in the file.
 */
export function csvCell(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return escapeCsvCell(String(value));
}

/**
 * Money as a spreadsheet sees it: a plain decimal number, no symbol and no
 * thousands separators.
 *
 * A currency symbol turns the column into text in Excel and Numbers, and the
 * first thing anybody does with an exported figure is add it up.
 */
export function csvMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Joins rows with CRLF, which is what RFC 4180 specifies and what Excel wants.
 *
 * A trailing newline is included: a file that ends mid-line reads as truncated
 * to some tools, and to some people.
 */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header.map(escapeCsvCell).join(","), ...rows.map((r) => r.join(","))].join("\r\n") + "\r\n";
}
