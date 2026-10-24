import { useEffect, useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useAction, useMutation, useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Download, FileSpreadsheet, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import * as XLSX from "xlsx"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { ORDER_SOURCES } from "@/convex/rules"
import { Guard } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill, StatusPill } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dateTime, errMsg, startOfDayBD, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/reports")({
  component: () => (
    <Guard perm="reports.view">
      <Reports />
    </Guard>
  ),
})

const DAY = 86400000
const bdDate = (t: number) => new Date(t + 6 * 3600000).toISOString().slice(0, 10)
const fromInput = (s: string) => new Date(`${s}T00:00:00+06:00`).getTime()

const PRESETS = [
  { key: "today", label: "Today", from: () => startOfDayBD(), to: () => startOfDayBD() + DAY - 1 },
  { key: "yesterday", label: "Yesterday", from: () => startOfDayBD() - DAY, to: () => startOfDayBD() - 1 },
  { key: "7d", label: "Last 7 days", from: () => startOfDayBD() - 6 * DAY, to: () => startOfDayBD() + DAY - 1 },
  { key: "30d", label: "Last 30 days", from: () => startOfDayBD() - 29 * DAY, to: () => startOfDayBD() + DAY - 1 },
  {
    key: "month", label: "This month",
    from: () => { const d = new Date(startOfDayBD() + 6 * 3600000); return fromInput(`${d.toISOString().slice(0, 8)}01`) },
    to: () => startOfDayBD() + DAY - 1,
  },
  {
    key: "lastmonth", label: "Last month",
    from: () => { const d = new Date(startOfDayBD() + 6 * 3600000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return fromInput(d.toISOString().slice(0, 10)) },
    to: () => { const d = new Date(startOfDayBD() + 6 * 3600000); return fromInput(`${d.toISOString().slice(0, 8)}01`) - 1 },
  },
]

function Reports() {
  const [tab, setTab] = useState<"overview" | "download">("overview")
  return (
    <div className="space-y-5">
      <PageHeader title="Reports" sub="Sales, deliveries, returns, products, areas and team — for any dates.">
        <div className="flex rounded-lg border bg-card p-1">
          {([["overview", "Overview"], ["download", "Download reports"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={cn("rounded-md px-4 py-1.5 text-sm font-medium", tab === k ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent")}>
              {l}
            </button>
          ))}
        </div>
      </PageHeader>
      {tab === "overview" ? <Overview /> : <DownloadReports />}
    </div>
  )
}

// ---------------- Overview ----------------
type Result = FunctionReturnType<typeof api.analytics.run>

function Overview() {
  const run = useAction(api.analytics.run)
  const [preset, setPreset] = useState("7d")
  const [custom, setCustom] = useState({ from: bdDate(startOfDayBD() - 6 * DAY), to: bdDate(startOfDayBD()) })
  const [basis, setBasis] = useState("created")
  const [data, setData] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)

  const range = useMemo(() => {
    const p = PRESETS.find((x) => x.key === preset)
    if (p) return { from: p.from(), to: p.to() }
    return { from: fromInput(custom.from), to: fromInput(custom.to) + DAY - 1 }
  }, [preset, custom])

  const load = async () => {
    if (!(range.to > range.from)) return toast.error("Pick a start date before the end date")
    setBusy(true)
    try { setData(await run({ ...range, basis })) } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [range.from, range.to, basis]) // eslint-disable-line react-hooks/exhaustive-deps

  const s = data?.summary
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-3">
        <div className="flex flex-wrap gap-1.5">
          {[...PRESETS, { key: "custom", label: "Custom dates" }].map((p) => (
            <button key={p.key} type="button" onClick={() => setPreset(p.key)}
              className={cn("rounded-full border px-3 py-1 text-sm", preset === p.key ? "border-tone-blue bg-tone-blue-bg font-semibold text-tone-blue" : "bg-background hover:bg-accent")}>
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex items-end gap-2">
            <div className="space-y-1"><Label className="text-xs">From</Label><Input type="date" className="h-8 w-40" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></div>
            <div className="space-y-1"><Label className="text-xs">To</Label><Input type="date" className="h-8 w-40" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></div>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Select value={basis} onValueChange={setBasis}>
            <SelectTrigger size="sm" className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="created">By order date</SelectItem>
              <SelectItem value="delivered">By delivery date</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={load} disabled={busy}><RefreshCw className={cn("size-4", busy && "animate-spin")} /> Refresh</Button>
        </div>
      </div>

      {!data ? <Loading /> : (
        <div className={cn("space-y-5 transition-opacity", busy && "opacity-60")}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Orders" value={s!.orders} hint={`${s!.items} items · avg ${taka(s!.avgOrder)}`} color="blue" />
            <Kpi label="Order value" value={taka(s!.value)} hint={`Discounts ${taka(s!.discount)}`} color="violet" />
            <Kpi label="Delivered" value={s!.delivered} hint={taka(s!.deliveredValue)} color="green" />
            <Kpi label="Delivery success" value={s!.successRate === null ? "—" : `${s!.successRate}%`} hint="Delivered ÷ (delivered + returned)" color={s!.successRate !== null && s!.successRate < 70 ? "red" : "green"} />
            <Kpi label="Returned" value={s!.returned} color="red" />
            <Kpi label="Cancelled" value={s!.cancelled} hint={`${s!.cancelRate}% of orders`} color="gray" />
            <Kpi label="Still open" value={s!.open} hint="Pending → in transit" color="amber" />
            {s!.profit !== null
              ? <Kpi label="Gross profit (delivered)" value={taka(s!.profit)} hint="Sales − product, courier & other costs" color="cyan" />
              : <Kpi label="Collected" value={taka(s!.collected)} hint="Advance + paid" color="cyan" />}
          </div>

          {data.days.length > 1 && (
            <Panel title="Orders by day">
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.days.map((d) => ({ ...d, label: d.day.slice(5) }))} margin={{ left: -16, right: 8, top: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
                    <XAxis dataKey="label" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip cursor={{ fill: "hsl(var(--muted))" }} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="delivered" name="Delivered" stackId="a" fill="hsl(var(--tone-green))" />
                    <Bar dataKey="returned" name="Returned" stackId="a" fill="hsl(var(--tone-red))" />
                    <Bar dataKey="cancelled" name="Cancelled" stackId="a" fill="hsl(var(--tone-gray))" />
                    <Bar dataKey="open" name="Open" stackId="a" fill="hsl(var(--tone-blue))" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          )}

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="By status" csv={() => data.byStatus.map((r) => ({ Status: r.status, Orders: r.orders, Value: r.value }))}>
              <div className="divide-y">
                {data.byStatus.map((r) => (
                  <div key={r.status} className="flex items-center gap-3 py-2 text-sm">
                    <StatusPill status={r.status} />
                    <Meter value={r.orders} max={data.summary.orders} />
                    <span className="w-12 text-right font-semibold tabular-nums">{r.orders}</span>
                    <span className="w-24 text-right text-muted-foreground tabular-nums">{taka(r.value)}</span>
                  </div>
                ))}
              </div>
            </Panel>
            <AggTable title="By order source" rows={data.bySource} />
          </div>

          <ProductsTable rows={data.products} />

          <div className="grid gap-5 lg:grid-cols-2">
            <AggTable title="By district / city" rows={data.byCity} limit={15} />
            <AggTable title="By team member (who created the order)" rows={data.byStaff} />
            <AggTable title="By payment type" rows={data.byMethod} />
            <AggTable title="By delivery partner" rows={data.byPartner} />
          </div>
        </div>
      )}
    </div>
  )
}

const KPI_COLOR: Record<string, string> = {
  blue: "border-l-tone-blue", violet: "border-l-tone-violet", green: "border-l-tone-green", red: "border-l-tone-red",
  gray: "border-l-tone-gray", amber: "border-l-tone-amber", cyan: "border-l-tone-cyan",
}
const KPI_TEXT: Record<string, string> = {
  blue: "text-tone-blue", violet: "text-tone-violet", green: "text-tone-green", red: "text-tone-red",
  gray: "text-tone-gray", amber: "text-tone-amber", cyan: "text-tone-cyan",
}

function Kpi({ label, value, hint, color }: { label: string; value: React.ReactNode; hint?: string; color: string }) {
  return (
    <div className={cn("rounded-xl border border-l-4 bg-card p-4", KPI_COLOR[color])}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", KPI_TEXT[color])}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

function Meter({ value, max, tone = "bg-tone-blue" }: { value: number; max: number; tone?: string }) {
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full", tone)} style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }} />
    </div>
  )
}

function saveFile(name: string, rows: Record<string, unknown>[], kind: "csv" | "xlsx" = "csv") {
  if (!rows.length) return toast.error("Nothing to download")
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "Report")
  XLSX.writeFile(wb, `${name.replace(/[^\w-]+/g, "-")}.${kind}`, { bookType: kind })
}

function Panel({ title, children, csv }: { title: string; children: React.ReactNode; csv?: () => Record<string, unknown>[] }) {
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {csv && <Button size="xs" variant="ghost" onClick={() => saveFile(title, csv())}><Download className="size-3.5" /> CSV</Button>}
      </div>
      <div className="px-4 py-2">{children}</div>
    </section>
  )
}

type AggRow = { key: string; orders: number; value: number; delivered: number; returned: number; cancelled: number }
const rate = (r: AggRow) => (r.delivered + r.returned ? Math.round((r.delivered / (r.delivered + r.returned)) * 100) : null)

function AggTable({ title, rows, limit }: { title: string; rows: AggRow[]; limit?: number }) {
  const [all, setAll] = useState(false)
  const shown = limit && !all ? rows.slice(0, limit) : rows
  return (
    <Panel title={title} csv={() => rows.map((r) => ({ Name: r.key, Orders: r.orders, Value: r.value, Delivered: r.delivered, Returned: r.returned, Cancelled: r.cancelled, "Success %": rate(r) ?? "" }))}>
      {rows.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No orders.</p> : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr><th className="py-2 font-medium" /><th className="py-2 text-right font-medium">Orders</th><th className="py-2 text-right font-medium">Value</th><th className="py-2 text-right font-medium text-tone-green">Deliv.</th><th className="py-2 text-right font-medium text-tone-red">Ret.</th><th className="py-2 text-right font-medium">Success</th></tr>
          </thead>
          <tbody className="divide-y">
            {shown.map((r) => {
              const p = rate(r)
              return (
                <tr key={r.key}>
                  <td className="py-2 pr-2">{r.key}</td>
                  <td className="py-2 text-right font-semibold tabular-nums">{r.orders}</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">{taka(r.value)}</td>
                  <td className="py-2 text-right tabular-nums text-tone-green">{r.delivered}</td>
                  <td className="py-2 text-right tabular-nums text-tone-red">{r.returned}</td>
                  <td className="py-2 text-right">{p === null ? <span className="text-muted-foreground">—</span> : <Pill tone={p >= 80 ? "green" : p >= 60 ? "amber" : "red"}>{p}%</Pill>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {limit && rows.length > limit && <button type="button" className="py-2 text-xs text-tone-blue hover:underline" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${rows.length}`}</button>}
    </Panel>
  )
}

function ProductsTable({ rows }: { rows: { name: string; sku: string; qty: number; amount: number; deliveredQty: number; returnedQty: number; orders: number }[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, 15)
  const max = rows[0]?.qty ?? 0
  return (
    <Panel title="Products sold (cancelled orders not counted)" csv={() => rows.map((r) => ({ Product: r.name, SKU: r.sku, Orders: r.orders, Qty: r.qty, Amount: r.amount, "Delivered qty": r.deliveredQty, "Returned qty": r.returnedQty }))}>
      {rows.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No products sold.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="py-2 font-medium">Product</th><th className="w-1/4 py-2" /><th className="py-2 text-right font-medium">Qty</th><th className="py-2 text-right font-medium">Amount</th><th className="py-2 text-right font-medium text-tone-green">Delivered</th><th className="py-2 text-right font-medium text-tone-red">Returned</th></tr>
            </thead>
            <tbody className="divide-y">
              {shown.map((r) => (
                <tr key={r.name}>
                  <td className="py-2 pr-2"><div className="font-medium">{r.name}</div><div className="text-xs text-muted-foreground">{r.sku}</div></td>
                  <td className="py-2 pr-3"><Meter value={r.qty} max={max} tone="bg-tone-violet" /></td>
                  <td className="py-2 text-right font-semibold tabular-nums">{r.qty}</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">{taka(r.amount)}</td>
                  <td className="py-2 text-right tabular-nums text-tone-green">{r.deliveredQty}</td>
                  <td className="py-2 text-right tabular-nums text-tone-red">{r.returnedQty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 15 && <button type="button" className="py-2 text-xs text-tone-blue hover:underline" onClick={() => setAll(!all)}>{all ? "Show top 15" : `Show all ${rows.length} products`}</button>}
    </Panel>
  )
}

// ---------------- Download reports (Nuport-style) ----------------
function DownloadReports() {
  const types = useQuery(api.reports.types)
  const list = useQuery(api.reports.list)
  const create = useMutation(api.reports.create)
  const [type, setType] = useState("sales_creation")
  const [from, setFrom] = useState(bdDate(startOfDayBD() - 29 * DAY))
  const [to, setTo] = useState(bdDate(startOfDayBD()))
  const [source, setSource] = useState("any")
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState<Id<"reports"> | null>(null)

  return (
    <div className="space-y-5">
      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">Create a report</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-72 flex-1 space-y-1"><Label className="text-xs">Report</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{(types ?? []).map((t) => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {type !== "stock_summary" && <>
            <div className="space-y-1"><Label className="text-xs">From</Label><Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="space-y-1"><Label className="text-xs">To</Label><Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            <div className="space-y-1"><Label className="text-xs">Source</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="any">All sources</SelectItem>{ORDER_SOURCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </>}
          <Button disabled={busy} onClick={async () => {
            setBusy(true)
            try {
              const id = await create({ type, from: fromInput(from), to: fromInput(to) + DAY - 1, source: source === "any" ? undefined : source })
              setOpenId(id); toast.success("Report is being prepared")
            } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
          }}><FileSpreadsheet className="size-4" /> Create report</Button>
        </div>
      </section>

      {openId && <ReportView id={openId} onClose={() => setOpenId(null)} />}

      <section className="rounded-xl border bg-card">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Recent reports</h2>
        {list === undefined || list === null ? <Loading /> : list.length === 0 ? (
          <div className="p-4"><Empty title="No reports yet">Create one above. It stays here so the team can download it again.</Empty></div>
        ) : (
          <div className="divide-y">
            {list.map((r) => (
              <button key={r._id} type="button" onClick={() => setOpenId(r._id)} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left text-sm hover:bg-muted/40">
                <span className="font-semibold text-tone-blue">#{r.code}</span>
                <span className="min-w-48 flex-1">{r.label}</span>
                <span className="text-xs text-muted-foreground">{r.params?.from ? `${bdDate(r.params.from)} → ${bdDate(r.params.to)}` : ""}{r.params?.source ? ` · ${r.params.source}` : ""}</span>
                <Pill tone={r.status === "ready" ? "green" : r.status === "failed" ? "red" : "amber"}>{r.status === "ready" ? `${r.rowCount} rows` : r.status === "failed" ? "Failed" : "Preparing…"}</Pill>
                <span className="text-xs text-muted-foreground">{r.createdBy} · {dateTime(r.createdAt)}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function ReportView({ id, onClose }: { id: Id<"reports">; onClose: () => void }) {
  const r = useQuery(api.reports.get, { id })
  if (r === undefined) return <Loading />
  if (r === null) return null
  const rows = (r.rows ?? []) as Record<string, unknown>[]
  const cols = r.columns ?? []
  const name = `${r.label} ${r.params?.from ? `${bdDate(r.params.from)} to ${bdDate(r.params.to)}` : ""}`
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h2 className="flex-1 text-sm font-semibold">#{r.code} · {r.label}</h2>
        {r.status === "ready" && <>
          <Button size="sm" variant="outline" onClick={() => saveFile(name, rows, "xlsx")}><Download className="size-4" /> Excel</Button>
          <Button size="sm" variant="outline" onClick={() => saveFile(name, rows, "csv")}><Download className="size-4" /> CSV</Button>
        </>}
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      {r.status === "running" ? <div className="p-6 text-center text-sm text-muted-foreground"><RefreshCw className="mx-auto mb-2 size-5 animate-spin" />Preparing your report…</div>
        : r.status === "failed" ? <p className="p-4 text-sm text-tone-red">{r.error}</p>
        : rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No data for these dates.</p> : (
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
                <tr>{cols.map((c) => <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{c}</th>)}</tr>
              </thead>
              <tbody className="divide-y">
                {rows.slice(0, 500).map((row, i) => (
                  <tr key={i}>{cols.map((c) => <td key={c} className="whitespace-nowrap px-3 py-1.5 tabular-nums">{String(row[c] ?? "")}</td>)}</tr>
                ))}
              </tbody>
            </table>
            {rows.length > 500 && <p className="p-3 text-xs text-muted-foreground">Showing first 500 of {rows.length} rows — download for all.</p>}
          </div>
        )}
    </section>
  )
}
