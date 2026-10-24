import { useMemo, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { Download } from "lucide-react"
import { toast } from "sonner"
import * as XLSX from "xlsx"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { PO_STATUS_LABEL } from "@/convex/rules"
import { Loading } from "@/components/bits"
import { POStatus } from "@/components/purchase-parts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dateOnly, startOfDayBD, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

const DAY = 86400000
const bdDate = (t: number) => new Date(t + 6 * 3600000).toISOString().slice(0, 10)
const fromInput = (s: string) => new Date(`${s}T00:00:00+06:00`).getTime()

const PRESETS: { key: string; label: string; days: number | null }[] = [
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 3 months", days: 90 },
  { key: "365d", label: "Last 12 months", days: 365 },
  { key: "all", label: "All time", days: null },
  { key: "custom", label: "Custom dates", days: 0 },
]

/** One page for suppliers: which shoes were ordered, how many pairs, what was paid and what is still due — by date. */
export function SupplierSummary() {
  const navigate = useNavigate()
  const suppliers = useQuery(api.purchasing.listSuppliers)
  const [preset, setPreset] = useState("90d")
  const [supplier, setSupplier] = useState("all")
  const [custom, setCustom] = useState({ from: bdDate(startOfDayBD() - 29 * DAY), to: bdDate(startOfDayBD()) })
  const [view, setView] = useState<"date" | "products" | "payments">("date")

  const range = useMemo(() => {
    const p = PRESETS.find((x) => x.key === preset)!
    if (p.key === "custom") return { from: fromInput(custom.from), to: fromInput(custom.to) + DAY - 1 }
    if (p.days === null) return { from: 0, to: startOfDayBD() + DAY - 1 }
    return { from: startOfDayBD() - (p.days - 1) * DAY, to: startOfDayBD() + DAY - 1 }
  }, [preset, custom])

  const data = useQuery(api.purchasing.summary, { ...range, supplierId: supplier === "all" ? undefined : (supplier as Id<"suppliers">) })
  const t = data?.totals

  const download = () => {
    if (!data) return
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.purchases.flatMap((p) => p.lines.map((l) => ({
      Date: bdDate(p.at), Purchase: p.code, Supplier: p.supplier, "Supplier invoice": p.ref ?? "", Status: PO_STATUS_LABEL[p.status] ?? p.status,
      Product: l.name, Size: l.size, "Pairs ordered": l.ordered, "Pairs received": l.received, "Unit cost": l.unitCost, "Line total": l.ordered * l.unitCost,
      "Purchase total": p.total, "Purchase paid": p.paid, "Purchase due": p.due,
    })))), "Purchases")
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.payments.map((p) => ({ Date: bdDate(p.at), Supplier: p.supplier, Amount: p.amount, Method: p.method, Reference: p.reference ?? "", For: p.po ?? "On account", Note: p.note ?? "", "Entered by": p.by }))), "Payments")
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.suppliers.map((s) => ({ Supplier: s.name, Purchases: s.purchases, "Pairs ordered": s.pairs, "Pairs received": s.received, "Bought (this period)": s.value, "Paid (this period)": s.paid, "Due now": s.dueNow }))), "By supplier")
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.products.map((p) => ({ Product: p.name, "Pairs ordered": p.ordered, "Pairs received": p.received, Value: p.value, Sizes: p.sizes }))), "By product")
    XLSX.writeFile(wb, `supplier-summary-${bdDate(range.from || Date.now())}-to-${bdDate(range.to)}.xlsx`)
    toast.success("Excel downloaded")
  }

  return (
    <div className="space-y-4" data-testid="supplier-summary">
      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-3">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" onClick={() => setPreset(p.key)}
              className={cn("rounded-full border px-3 py-1 text-sm", preset === p.key ? "border-tone-blue bg-tone-blue-bg font-semibold text-tone-blue" : "bg-background hover:bg-accent")}>
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex items-center gap-2">
            <Input type="date" className="h-8 w-40" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <span className="text-sm text-muted-foreground">to</span>
            <Input type="date" className="h-8 w-40" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Select value={supplier} onValueChange={setSupplier}>
            <SelectTrigger size="sm" className="w-52"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All suppliers</SelectItem>
              {(suppliers ?? []).map((s) => <SelectItem key={s._id} value={s._id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={download} disabled={!data}><Download className="size-4" /> Excel</Button>
        </div>
      </div>

      {!data ? <Loading /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Purchases" value={t!.purchases} tone="blue" />
            <Tile label="Pairs ordered" value={t!.pairs} tone="violet" />
            <Tile label="Pairs received" value={t!.received} hint={t!.pairs ? `${t!.pairs - t!.received} still to come` : undefined} tone="teal" />
            <Tile label="Bought" value={taka(t!.value)} tone="amber" />
            <Tile label="Paid" value={taka(t!.paid)} tone="green" hint="in these dates" />
            <Tile label="We owe now" value={taka(t!.dueNow)} tone="red" hint="all suppliers, today" />
          </div>

          {data.suppliers.length > 0 && (
            <section className="rounded-xl border bg-card">
              <h2 className="border-b px-4 py-3 text-sm font-semibold">By supplier</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr><th className="px-4 py-2 font-medium">Supplier</th><th className="px-3 py-2 text-right font-medium">Purchases</th><th className="px-3 py-2 text-right font-medium">Pairs ordered</th><th className="px-3 py-2 text-right font-medium">Received</th><th className="px-3 py-2 text-right font-medium">Bought</th><th className="px-3 py-2 text-right font-medium text-tone-green">Paid</th><th className="px-4 py-2 text-right font-medium text-tone-red">Due now</th></tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.suppliers.map((s) => (
                      <tr key={s._id} className="cursor-pointer hover:bg-muted/30" onClick={() => navigate({ to: "/supplier", search: { id: s._id } })}>
                        <td className="px-4 py-2.5 font-medium">{s.name}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{s.purchases}</td>
                        <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{s.pairs}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{s.received}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{taka(s.value)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-tone-green">{taka(s.paid)}</td>
                        <td className={cn("px-4 py-2.5 text-right font-semibold tabular-nums", s.dueNow > 0 ? "text-tone-red" : s.dueNow < 0 ? "text-tone-blue" : "")}>{s.dueNow < 0 ? `${taka(-s.dueNow)} adv.` : taka(s.dueNow)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <div className="flex gap-1.5">
            {([["date", `Date-wise (${data.purchases.length})`], ["products", `Shoes ordered (${data.products.length})`], ["payments", `Payments (${data.payments.length})`]] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setView(k)}
                className={cn("rounded-lg px-3.5 py-1.5 text-sm font-medium", view === k ? "bg-foreground text-background" : "bg-card hover:bg-accent")}>{l}</button>
            ))}
          </div>

          {view === "date" && (
            data.purchases.length === 0 ? <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">No purchases in these dates.</p> : (
              <div className="space-y-3">
                {data.purchases.map((p) => (
                  <section key={p._id} className="rounded-xl border bg-card">
                    <button type="button" onClick={() => navigate({ to: "/purchase", search: { id: p._id } })} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5 text-left hover:bg-muted/30">
                      <span className="text-sm font-semibold">{dateOnly(p.at)}</span>
                      <span className="font-semibold text-tone-blue">{p.code}</span>
                      <span className="text-sm">{p.supplier}{p.ref ? <span className="text-muted-foreground"> · Inv {p.ref}</span> : null}</span>
                      <POStatus status={p.status} label={PO_STATUS_LABEL[p.status] ?? p.status} />
                      <span className="ml-auto flex flex-wrap gap-x-4 text-sm tabular-nums">
                        <span><b>{p.pairs}</b> pairs{p.received ? <span className="text-muted-foreground"> ({p.received} in)</span> : null}</span>
                        <span>{taka(p.total)}</span>
                        <span className="text-tone-green">Paid {taka(p.paid)}</span>
                        <span className={cn("font-semibold", p.due > 0 ? "text-tone-red" : "text-muted-foreground")}>Due {taka(p.due)}</span>
                      </span>
                    </button>
                    <div className="flex flex-wrap gap-1.5 px-4 py-2.5">
                      {p.lines.map((l, i) => (
                        <span key={i} className="rounded-md bg-muted px-2 py-1 text-xs">
                          {l.name} · <b>{l.size}</b> × {l.ordered}{l.received ? <span className="text-tone-green"> ({l.received} in)</span> : null}
                        </span>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )
          )}

          {view === "products" && (
            <section className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr><th className="px-4 py-2 font-medium">Shoe</th><th className="px-3 py-2 font-medium">Sizes ordered</th><th className="px-3 py-2 text-right font-medium">Pairs ordered</th><th className="px-3 py-2 text-right font-medium">Received</th><th className="px-4 py-2 text-right font-medium">Value</th></tr>
                </thead>
                <tbody className="divide-y">
                  {data.products.map((p) => (
                    <tr key={p.name}>
                      <td className="px-4 py-2.5 font-medium">{p.name}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{p.sizes}</td>
                      <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{p.ordered}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{p.received}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{taka(p.value)}</td>
                    </tr>
                  ))}
                  {data.products.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">No shoes ordered in these dates.</td></tr>}
                </tbody>
              </table>
            </section>
          )}

          {view === "payments" && (
            <section className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr><th className="px-4 py-2 font-medium">Date</th><th className="px-3 py-2 font-medium">Supplier</th><th className="px-3 py-2 font-medium">Paid by</th><th className="px-3 py-2 font-medium">For</th><th className="px-3 py-2 font-medium">Reference / note</th><th className="px-4 py-2 text-right font-medium">Amount</th></tr>
                </thead>
                <tbody className="divide-y">
                  {data.payments.map((p) => (
                    <tr key={p._id} className={cn(p.poId && "cursor-pointer hover:bg-muted/30")} onClick={() => p.poId && navigate({ to: "/purchase", search: { id: p.poId } })}>
                      <td className="whitespace-nowrap px-4 py-2.5">{dateOnly(p.at)}</td>
                      <td className="px-3 py-2.5">{p.supplier}</td>
                      <td className="px-3 py-2.5">{p.method}</td>
                      <td className="px-3 py-2.5">{p.po ?? <span className="text-muted-foreground">On account</span>}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{[p.reference, p.note].filter(Boolean).join(" · ") || "—"} · {p.by}</td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-tone-green">{taka(p.amount)}</td>
                    </tr>
                  ))}
                  {data.payments.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No payments in these dates.</td></tr>}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  )
}

const TILE: Record<string, string> = {
  blue: "border-l-tone-blue text-tone-blue", violet: "border-l-tone-violet text-tone-violet", teal: "border-l-tone-teal text-tone-teal",
  amber: "border-l-tone-amber text-tone-amber", green: "border-l-tone-green text-tone-green", red: "border-l-tone-red text-tone-red",
}

function Tile({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone: string }) {
  const [border, text] = TILE[tone].split(" ")
  return (
    <div className={cn("rounded-xl border border-l-4 bg-card p-3.5", border)}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-xl font-semibold tabular-nums", text)}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}
