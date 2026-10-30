// Comprehensive Inventory Report (Phase 1 · Task 2) — summary dashboard + Export CSV.
//
// Rendered as a new "Report" tab on the existing Inventory page. It is a pure read of
// `api.inventoryReport.summary`; nothing here writes to Convex, so the Stock and Movements tabs and every
// live operational flow keep behaving exactly as they did before.

import { useMemo, useState } from "react"
import { useQuery } from "convex/react"
import { Link } from "@tanstack/react-router"
import { AlertTriangle, ArrowUpRight, Download, PackageX, RefreshCw, Search } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Empty, Loading, Pill, Stat } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dateTime, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

type Row = {
  key: string
  productId: string
  productTitle: string
  color: string
  locationId: string
  locationName: string
  sku: string
  variantSkus: string[]
  sizes: { size: string; sku: string; available: number; committed: number; exists: boolean }[]
  sizeBreakdown: string
  available: number
  committed: number
  processing: number
  inTransit: number
  units30: number
  perDay: number
  daysCover: number | null
  stockValue: number
  status: "out" | "low" | "ok"
}

const STATUS_LABEL: Record<Row["status"], string> = { out: "Out of stock", low: "Low stock", ok: "In stock" }
const STATUS_TONE = { out: "red", low: "amber", ok: "green" } as const

/** RFC-4180 CSV: quote every cell, double any inner quote. Excel opens this without a dialog. */
function toCsv(rows: Record<string, string | number>[]): string {
  if (!rows.length) return ""
  const cols = Object.keys(rows[0])
  const cell = (v: string | number) => `"${String(v ?? "").replace(/"/g, '""')}"`
  return [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n")
}

function download(name: string, text: string) {
  // BOM so Excel reads the Bangla product names as UTF-8 instead of mojibake.
  const blob = new Blob([`\uFEFF${text}`], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function InventoryReport() {
  const [threshold, setThreshold] = useState(3)
  const [q, setQ] = useState("")
  const [only, setOnly] = useState<"all" | "low" | "out" | "attention">("all")
  const [warehouse, setWarehouse] = useState("all")
  const data = useQuery(api.inventoryReport.summary, { lowStockThreshold: threshold })

  const rows = useMemo<Row[]>(() => {
    if (!data) return []
    const t = q.trim().toLowerCase()
    return (data.rows as Row[])
      .filter(
        (r) =>
          !t ||
          r.sku.toLowerCase().includes(t) ||
          r.productTitle.toLowerCase().includes(t) ||
          r.color.toLowerCase().includes(t) ||
          r.variantSkus.some((s) => s.toLowerCase().includes(t)),
      )
      .filter((r) => warehouse === "all" || r.locationId === warehouse)
      .filter((r) =>
        only === "all"
          ? true
          : only === "attention"
            ? r.status !== "ok"
            : only === "low"
              ? r.status === "low"
              : r.status === "out",
      )
  }, [data, q, only, warehouse])

  const exportCsv = () => {
    if (!rows.length) return toast.error("Nothing to export")
    // One column per size (not one packed "40: – · 41: – …" string) so Excel lines them up instead of
    // cramming a sentence into a single cell — that's what made the old export unreadable for the team.
    const csv = toCsv(
      rows.map((r) => {
        const sizeCols: Record<string, string | number> = {}
        for (const c of r.sizes) sizeCols[`Size ${c.size}`] = c.exists ? c.available : ""
        return {
          SKU: r.sku,
          "Product Title": r.productTitle,
          Color: r.color,
          Warehouse: r.locationName,
          ...sizeCols,
          "Available Stock": r.available,
          "Committed Stock": r.committed,
          "Low Stock Alert Status": STATUS_LABEL[r.status],
          "30-Day Run-Rate Velocity": r.units30,
        }
      }),
    )
    const stamp = new Date().toISOString().slice(0, 10)
    download(`inventory-report-${stamp}.csv`, csv)
    toast.success(`Exported ${rows.length} rows`)
  }

  if (data === undefined) return <Loading />
  if (data === null) return <Empty title="No access">Ask an admin for the reports permission.</Empty>

  const t = data.totals

  return (
    <div className="space-y-5">
      {/* ---- Summary dashboard ---- */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Available units" value={t.available} hint={`${t.skus} SKUs · ${t.products} product rows`} />
        <Stat
          label="Committed"
          value={t.committed}
          hint="on unshipped orders"
          tone={t.committed > t.available ? "amber" : undefined}
        />
        <Stat label="In transit" value={t.inTransit} hint="with the courier" />
        <Stat
          label="Low stock"
          value={t.low}
          hint={`≤ ${data.threshold} units`}
          tone={t.low ? "amber" : undefined}
        />
        <Stat label="Out of stock" value={t.out} hint="zero or negative" tone={t.out ? "red" : undefined} />
        <Stat
          label={`${data.velocityDays}-day velocity`}
          value={t.units30}
          hint={t.daysCover === null ? "no sales yet" : `≈ ${t.daysCover} days of cover`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Size availability across the whole catalogue */}
        <section className="rounded-xl border bg-card lg:col-span-2">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Availability by size</h2>
            <p className="text-xs text-muted-foreground">Every size 40–44, summed across all products and warehouses.</p>
          </div>
          <div className="space-y-2.5 px-4 py-3">
            {data.bySize.map((s) => {
              const max = Math.max(1, ...data.bySize.map((x) => Math.max(0, x.available)))
              const pct = Math.max(2, (Math.max(0, s.available) / max) * 100)
              return (
                <div key={s.size} className="flex items-center gap-3 text-sm">
                  <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">Size {s.size}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        s.available <= 0 ? "bg-tone-red" : s.available <= data.threshold ? "bg-tone-amber" : "bg-tone-teal",
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-14 text-right font-semibold tabular-nums">{s.available}</span>
                  <span className="w-24 text-right text-xs text-muted-foreground tabular-nums">
                    {s.committed} committed
                  </span>
                </div>
              )
            })}
          </div>
        </section>

        {/* Needs attention */}
        <section className="rounded-xl border bg-card">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <AlertTriangle className="size-4 text-tone-amber" />
            <h2 className="text-sm font-semibold">Needs attention</h2>
          </div>
          {data.needsAttention.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Everything is above the low-stock line.</p>
          ) : (
            <ul className="divide-y">
              {data.needsAttention.map((r) => (
                <li key={r.key} className="flex items-center gap-2 px-4 py-2 text-sm">
                  <Pill tone={STATUS_TONE[r.status]}>{r.status === "out" ? "Out" : "Low"}</Pill>
                  <span className="min-w-0 flex-1 truncate">
                    {r.productTitle} <span className="text-muted-foreground">· {r.color}</span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{r.available}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Top movers */}
      {data.topMovers.length > 0 && (
        <section className="rounded-xl border bg-card">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Fastest movers · last {data.velocityDays} days</h2>
          </div>
          <div className="grid gap-2 px-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
            {data.topMovers.map((r) => (
              <div key={r.key} className="rounded-lg border bg-background p-2.5">
                <div className="truncate text-xs font-medium">{r.productTitle}</div>
                <div className="text-[11px] text-muted-foreground">{r.color}</div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-lg font-semibold tabular-nums">{r.units30}</span>
                  <span className="text-[11px] text-muted-foreground">units · {r.perDay}/day</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- Controls ---- */}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-3">
        <div className="min-w-56 flex-1 space-y-1">
          <Label className="text-xs">Search</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="SKU, product or colour"
              className="pl-8"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Warehouse</Label>
          <Select value={warehouse} onValueChange={setWarehouse}>
            <SelectTrigger size="sm" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All warehouses</SelectItem>
              {data.warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Low-stock threshold</Label>
          <Select value={String(threshold)} onValueChange={(v) => setThreshold(Number(v))}>
            <SelectTrigger size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 5, 10].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  ≤ {n} units
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["all", "All"],
              ["attention", "Needs attention"],
              ["low", "Low"],
              ["out", "Out"],
            ] as const
          ).map(([k, l]) => (
            <Button key={k} size="sm" variant={only === k ? "default" : "outline"} onClick={() => setOnly(k)}>
              {l}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            <RefreshCw className="mr-1 inline size-3" />
            {dateTime(data.generatedAt)}
          </span>
          <Button size="sm" onClick={exportCsv} disabled={!rows.length}>
            <Download className="size-4" /> Export CSV
          </Button>
        </div>
      </div>

      {/* ---- Table ---- */}
      {rows.length === 0 ? (
        <Empty title="Nothing to show">
          {data.rows.length === 0 ? "Add products and record stock in first." : "No rows match this filter."}
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">SKU</th>
                <th className="p-3 font-medium">Product title</th>
                <th className="p-3 font-medium">Color</th>
                <th className="p-3 font-medium">Warehouse</th>
                <th className="p-3 font-medium">Size breakdown</th>
                <th className="p-3 text-right font-medium">Available</th>
                <th className="p-3 text-right font-medium">Committed</th>
                <th className="p-3 font-medium">Low stock</th>
                <th className="p-3 text-right font-medium">30-day velocity</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.key} className="hover:bg-muted/30">
                  <td className="p-3 font-mono text-xs whitespace-nowrap">{r.sku}</td>
                  <td className="p-3">
                    <Link
                      to="/products/$productId"
                      params={{ productId: r.productId }}
                      className="font-medium text-tone-blue hover:underline"
                    >
                      {r.productTitle}
                    </Link>
                  </td>
                  <td className="p-3 whitespace-nowrap">{r.color}</td>
                  <td className="p-3 whitespace-nowrap text-muted-foreground">{r.locationName}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1">
                      {r.sizes.map((c) => (
                        <span
                          key={c.size}
                          title={c.exists ? `${c.sku} · ${c.available} available · ${c.committed} committed` : "No such variant"}
                          className={cn(
                            "rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums whitespace-nowrap",
                            !c.exists
                              ? "bg-muted text-muted-foreground/60"
                              : c.available <= 0
                                ? "bg-tone-red-bg text-tone-red"
                                : c.available <= data.threshold
                                  ? "bg-tone-amber-bg text-tone-amber"
                                  : "bg-tone-green-bg text-tone-green",
                          )}
                        >
                          {c.size}:{c.exists ? c.available : "–"}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td
                    className={cn(
                      "p-3 text-right font-semibold tabular-nums",
                      r.available < 0 ? "text-tone-red" : r.available <= data.threshold ? "text-tone-amber" : "",
                    )}
                  >
                    {r.available}
                  </td>
                  <td className="p-3 text-right tabular-nums">{r.committed}</td>
                  <td className="p-3">
                    <Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill>
                  </td>
                  <td className="p-3 text-right tabular-nums whitespace-nowrap">
                    {r.units30}
                    <span className="ml-1 text-xs text-muted-foreground">({r.perDay}/d)</span>
                  </td>
                  <td className="p-3 text-right">
                    <Link
                      to="/products/$productId"
                      params={{ productId: r.productId }}
                      className="inline-flex items-center gap-0.5 text-xs text-tone-blue hover:underline"
                    >
                      Open <ArrowUpRight className="size-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t bg-muted/30 text-xs font-semibold">
              <tr>
                <td className="p-3" colSpan={5}>
                  {rows.length} row{rows.length === 1 ? "" : "s"}
                  {rows.length !== data.rows.length ? ` of ${data.rows.length}` : ""} · stock value{" "}
                  {taka(rows.reduce((s, r) => s + r.stockValue, 0))}
                </td>
                <td className="p-3 text-right tabular-nums">{rows.reduce((s, r) => s + r.available, 0)}</td>
                <td className="p-3 text-right tabular-nums">{rows.reduce((s, r) => s + r.committed, 0)}</td>
                <td className="p-3" />
                <td className="p-3 text-right tabular-nums">{rows.reduce((s, r) => s + r.units30, 0)}</td>
                <td className="p-3" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {t.shortage > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-tone-red">
          <PackageX className="size-3.5" />
          {t.shortage} unit{t.shortage === 1 ? "" : "s"} oversold — approved orders beyond available stock.
        </p>
      )}
    </div>
  )
}
