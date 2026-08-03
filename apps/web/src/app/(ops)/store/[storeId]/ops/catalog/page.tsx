import type { Metadata } from "next";
import { Card } from "@/components/shell";
import { ImportForm } from "./import-form";

export const metadata: Metadata = { title: "Catalog" };

export default async function CatalogPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;

  return (
    <div className="mt-8 space-y-6">
      <Card
        title="Export your catalog"
        description="A spreadsheet of everything you sell."
      >
        <p className="text-sm text-ink-muted">
          Open it in Excel or Numbers, make your changes, and import it back. Prices
          are written as ordinary amounts, so 8.00 means $8.00.
        </p>
        {/* A plain link, not a fetch: the browser's own download handling is
            better than anything reimplemented, and it works without JS. */}
        <a
          href={`/api/stores/${storeId}/catalog.csv`}
          className="mt-4 inline-block rounded-card border border-line px-5 py-2.5 text-sm font-medium text-ink"
        >
          Download catalog.csv
        </a>
      </Card>

      <Card title="Import products" description="Add or update products from a spreadsheet.">
        <div className="space-y-4">
          <div className="text-sm text-ink-muted">
            <p>
              Products are matched on <strong>SKU</strong>. A row whose SKU you already
              use updates that product; anything else is added as a draft.
            </p>
            <p className="mt-2">
              The only columns that must be present are <code>name</code> and{" "}
              <code>price</code>. Also understood: <code>sku</code>, <code>brand</code>,{" "}
              <code>description</code>, <code>category</code>,{" "}
              <code>compare_at_price</code>, <code>barcode</code>.
            </p>
            <p className="mt-2">
              Rows that can&rsquo;t be read are reported and skipped — the rest of the
              file still imports.
            </p>
          </div>

          <ImportForm storeId={storeId} />
        </div>
      </Card>
    </div>
  );
}
