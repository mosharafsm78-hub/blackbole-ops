import { cn } from "@/lib/utils"

/** The four stock metrics the Operations Director specified, in this exact order. Both the headline cards
 *  and the warehouse mini-table render from this list, so the two can never drift apart. */
export const STOCK_METRICS = [
  { key: "available", label: "Available", hint: "On the shelf, ready to sell" },
  { key: "committed", label: "Committed", hint: "Pending, On Hold, Approved, Processing, Pre-Order, Ready to Ship" },
  { key: "inTransit", label: "In Transit", hint: "On a truck to the customer" },
  { key: "returning", label: "Returning", hint: "Courier is bringing it back" },
] as const

export type StockMetricKey = (typeof STOCK_METRICS)[number]["key"]
export type StockMetrics = Record<StockMetricKey, number>

export type WarehouseStock = StockMetrics & {
  locationId: string
  locationName: string
  active: boolean
  isDefault: boolean
}

const zero = (): StockMetrics => ({ available: 0, committed: 0, inTransit: 0, returning: 0 })

/** Sum the warehouse rows into the card totals. The table footer and the cards both use this, so the
 *  breakdown always reconciles with the headline numbers. */
export function sumWarehouses(rows: WarehouseStock[]): StockMetrics {
  const out = zero()
  for (const r of rows) {
    out.available += r.available
    out.committed += r.committed
    out.inTransit += r.inTransit
    out.returning += r.returning
  }
  return out
}

/** A metric that is zero is shown muted rather than as a loud "0" — the eye should land on real stock. */
function toneFor(key: StockMetricKey, n: number) {
  if (n > 0) return key === "available" ? "text-emerald-600" : ""
  if (n < 0) return "text-red-600"
  return "text-muted-foreground"
}

export function StockMetricCards({ metrics }: { metrics: StockMetrics }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="stock-metric-cards">
      {STOCK_METRICS.map((m) => (
        <div key={m.key} className="rounded-lg border bg-card p-3" data-testid={`metric-${m.key}`}>
          <div className="text-xs font-medium text-muted-foreground">{m.label}</div>
          <div className={cn("mt-1 text-2xl font-semibold tabular-nums", toneFor(m.key, metrics[m.key]))}>
            {metrics[m.key]}
          </div>
          <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{m.hint}</div>
        </div>
      ))}
    </div>
  )
}

/** Per-warehouse split of the same four metrics. Horizontally scrollable on narrow screens with the
 *  warehouse name pinned, so the numbers stay readable on a phone instead of being squeezed. */
export function WarehouseStockTable({
  rows,
  sizeTitle,
  totals,
}: {
  rows: WarehouseStock[]
  sizeTitle: string
  totals: StockMetrics
}) {
  if (rows.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground"
        data-testid="warehouse-empty"
      >
        No active warehouse yet — add one under Settings → Warehouses.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border bg-background" data-testid="warehouse-stock">
      <table className="w-full min-w-[520px] border-collapse text-sm">
        <caption className="sr-only">Stock by warehouse for size {sizeTitle}</caption>
        <thead>
          <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
            <th scope="col" className="sticky left-0 z-10 bg-muted/50 px-3 py-2 text-left font-semibold">
              Warehouse
            </th>
            {STOCK_METRICS.map((m) => (
              <th key={m.key} scope="col" className="px-3 py-2 text-right font-semibold whitespace-nowrap">
                {m.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((w) => (
            <tr key={w.locationId} data-testid="warehouse-row">
              <th scope="row" className="sticky left-0 z-10 bg-background px-3 py-2.5 text-left font-medium">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      w.available > 0 ? "bg-emerald-500" : w.available < 0 ? "bg-red-500" : "bg-muted-foreground/30",
                    )}
                    aria-hidden
                  />
                  <span className="truncate">{w.locationName}</span>
                  {w.isDefault && (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                      Default
                    </span>
                  )}
                  {!w.active && (
                    <span className="shrink-0 rounded-full bg-tone-red-bg px-1.5 py-0.5 text-[10px] font-semibold text-tone-red">
                      Inactive
                    </span>
                  )}
                </span>
              </th>
              {STOCK_METRICS.map((m) => (
                <td
                  key={m.key}
                  className={cn("px-3 py-2.5 text-right tabular-nums", toneFor(m.key, w[m.key]))}
                  data-testid={`cell-${m.key}`}
                >
                  {w[m.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t bg-muted/50 text-xs font-semibold" data-testid="warehouse-total">
            <th scope="row" className="sticky left-0 z-10 bg-muted/50 px-3 py-2 text-left">
              Total
            </th>
            {STOCK_METRICS.map((m) => (
              <td key={m.key} className="px-3 py-2 text-right tabular-nums">
                {totals[m.key]}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
