import type { Metadata } from "next";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Card } from "@/components/shell";
import type { Store } from "@/lib/types";

export const metadata: Metadata = { title: "Customers" };

const PAGE_SIZE = 50;

interface CustomerRow {
  customerId: string;
  name: string;
  email: string;
  ordersCount: number;
  lifetimeCents: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
}

interface CustomerList {
  rows: CustomerRow[];
  total: number;
}

const SORTS = {
  spend: "Biggest spenders",
  recent: "Most recent",
} as const;

type Sort = keyof typeof SORTS;

export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ sort?: string; page?: string }>;
}) {
  const { storeId } = await params;
  const query = await searchParams;

  const sort: Sort = query.sort === "recent" ? "recent" : "spend";
  const page = Math.max(Number(query.page ?? 1) || 1, 1);
  const offset = (page - 1) * PAGE_SIZE;

  let store: Store;
  let list: CustomerList | null;
  try {
    [store, list] = await Promise.all([
      api<Store>(`/stores/${storeId}`),
      api<CustomerList>(
        `/stores/${storeId}/reports/customers?sort=${sort}&limit=${PAGE_SIZE}&offset=${offset}`,
      ),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      return (
        <Card title="Customers">
          <p className="text-sm text-ink-muted">
            You don&rsquo;t have access to this shop&rsquo;s customer list. An owner can grant it
            under Team.
          </p>
        </Card>
      );
    }
    throw err;
  }

  const currency = store.currency ?? "USD";
  const lastPage = Math.max(Math.ceil((list?.total ?? 0) / PAGE_SIZE), 1);

  return (
    <div className="space-y-6">
      <nav aria-label="Sort" className="flex flex-wrap gap-2">
        {(Object.keys(SORTS) as Sort[]).map((key) => (
          <Link
            key={key}
            href={`?sort=${key}`}
            aria-current={key === sort ? "page" : undefined}
            className={`tap-target rounded-card border px-4 py-2 text-sm ${
              key === sort
                ? "border-brand bg-brand text-brand-ink"
                : "border-line bg-surface text-ink"
            }`}
          >
            {SORTS[key]}
          </Link>
        ))}
      </nav>

      <Card
        title="Customers"
        actions={
          <a
            href={`/api/stores/${storeId}/reports/customers`}
            className="tap-target rounded-card border border-line px-4 py-2 text-sm text-ink"
          >
            Export CSV
          </a>
        }
        description={
          list.total === 0
            ? "Nobody has ordered with an account yet."
            : `${list.total.toLocaleString()} ${list.total === 1 ? "person" : "people"} with an account.`
        }
      >
        {list.rows.length === 0 ? (
          <p className="text-sm text-ink-muted">
            {/* Said plainly, because it is the likeliest reading of an empty
                list and not a fault: a shop can trade for months on guest
                checkouts alone. */}
            Orders placed without an account aren&rsquo;t counted here — a guest checkout
            leaves an email address, not a customer record.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <th scope="col" className="py-2 pr-4 font-medium text-ink">
                    Customer
                  </th>
                  <Th>Orders</Th>
                  <Th>Spent</Th>
                  <Th>First order</Th>
                  <Th>Last order</Th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((row) => (
                  <tr key={row.customerId} className="border-b border-line last:border-0">
                    <th scope="row" className="py-2 pr-4 text-left font-normal text-ink">
                      {row.name}
                      <span className="ml-2 text-ink-muted">{row.email}</span>
                    </th>
                    <Td>{row.ordersCount.toLocaleString()}</Td>
                    <Td>{money(row.lifetimeCents, currency)}</Td>
                    <Td>{day(row.firstOrderAt)}</Td>
                    <Td>{day(row.lastOrderAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {lastPage > 1 && (
          <nav
            aria-label="Pages"
            className="mt-4 flex items-center justify-between gap-4 text-sm"
          >
            {page > 1 ? (
              <Link
                href={`?sort=${sort}&page=${page - 1}`}
                className="tap-target text-ink underline underline-offset-4"
              >
                Previous
              </Link>
            ) : (
              <span className="text-ink-muted">Previous</span>
            )}
            <span className="text-ink-muted">
              Page {page.toLocaleString()} of {lastPage.toLocaleString()}
            </span>
            {page < lastPage ? (
              <Link
                href={`?sort=${sort}&page=${page + 1}`}
                className="tap-target text-ink underline underline-offset-4"
              >
                Next
              </Link>
            ) : (
              <span className="text-ink-muted">Next</span>
            )}
          </nav>
        )}
      </Card>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="py-2 pr-4 text-right font-medium text-ink">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="py-2 pr-4 text-right tabular-nums text-ink">{children}</td>;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function day(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
