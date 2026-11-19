import { useMemo, useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useAction } from "convex/react"
import { Check, Download, RefreshCw, Search } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Guard } from "@/components/app-shell"
import { Loading, PageHeader, StatusPill } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { dateTime, errMsg, startOfDayBD, taka } from "@/lib/format"
import { usePolledAction } from "@/lib/use-polled-action"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/profit")({
  component: () => (
    <Guard perm="reports.view">
      <ProfitPage />
    </Guard>
  ),
})

const DAY = 86400000
const bdDate = (t: number) => new Date(t + 6 * 3600000).toISOString().slice(0, 10)
const dayStart = (s: string) => Date.parse(`${s}T00:00:00+06:00`)
type Outcome = "delivered" | "returned" | "cancelled" | "open"
const OUTCOME: Record<Outcome, { label: string; dot: string; text: string; bg: string }> = {
  delivered: { label: "Delivered", dot: "bg-tone-green", text: "text-tone-green", bg: "bg-tone-green-bg" },
  returned: { label: "Returned", dot: "bg-tone-red", text: "text-tone-red", bg: "bg-tone-red-bg" },
  cancelled: { label: "Cancelled", dot: "bg-muted-foreground", text: "text-muted-foreground", bg: "bg-muted" },
  open: { label: "Still open", dot: "bg-tone-blue", text: "text-tone-blue", bg: "bg-tone-blue-bg" },
}
/** Money with a sign and colour: green profit, red loss. */
function Money({ n, sign = false, className }: { n: number | null | undefined; sign?: boolean; className?: string }) {
  if (n === null || n === undefined) return <span className={cn("text-muted-foreground", className)}>—</span>
  const r = Math.round(n)
  return <span className={cn("tabular-nums", sign && (r > 0 ? "text-tone-green" : r < 0 ? "text-tone-red" : ""), className)}>{sign && r > 0 ? "+" : r < 0 ? "−" : ""}{taka(Math.abs(r))}</span>
}

function presets() {
  const today = bdDate(Date.now())
  const now = new Date(Date.now() + 6 * 3600000)
  const monthStart = `${today.slice(0, 7)}-01`
  const lastStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10)
  const lastEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10)
  return [
    { label: "This month", from: monthStart, to: today },
    { label: "Last month", from: lastStart, to: lastEnd },
    { label: "Last 7 days", from: bdDate(Date.now() - 6 * DAY), to: today },
    { label: "Yesterday", from: bdDate(Date.now() - DAY), to: bdDate(Date.now() - DAY) },
    { label: "Today", from: today, to: today },
  ]
}

function ProfitPage() {
  const P = presets()
  const [fromD, setFromD] = useState(P[0].from)
  const [toD, setToD] = useState(P[0].to)
  const from = dayStart(fromD), to = dayStart(toD) + DAY - 1
  const valid = Number.isFinite(from) && Number.isFinite(to) && from <= to
  const [data, refetch] = usePolledAction(api.profit.report, { from: valid ? from : startOfDayBD(), to: valid ? to : startOfDayBD() + DAY - 1 }, 5 * 60000)
  const refresh = useAction(api.profit.refreshSpend)
  const [busy, setBusy] = useState(false)
  const doRefresh = async () => {
    setBusy(true)
    try { await refresh({ from, to }); refetch(); toast.success("Meta spend updated") } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      <PageHeader title="Profit" sub="Order by order: what each order earned or lost after product cost, Pathao, packaging and Meta ads.">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void doRefresh()}><RefreshCw className={cn("size-3.5", busy && "animate-spin")} /> Refresh from Meta</Button>
        {data && <Button size="sm" variant="outline" onClick={() => downloadCsv(data)}><Download className="size-3.5" /> Download</Button>}
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        {P.map((p) => (
          <button key={p.label} type="button" onClick={() => { setFromD(p.from); setToD(p.to) }} className={cn("rounded-full border px-3 py-1 text-xs font-medium", fromD === p.from && toD === p.to ? "border-foreground bg-foreground text-background" : "bg-card text-muted-foreground hover:bg-accent")}>{p.label}</button>
        ))}
        <span className="mx-1 h-5 w-px bg-border" />
        <input type="date" value={fromD} max={toD} onChange={(e) => setFromD(e.target.value)} className="rounded-md border bg-card px-2 py-1 text-xs" />
        <span className="text-xs text-muted-foreground">to</span>
        <input type="date" value={toD} min={fromD} onChange={(e) => setToD(e.target.value)} className="rounded-md border bg-card px-2 py-1 text-xs" />
      </div>

      {!data ? <Loading /> : <Report d={data} />}
    </div>
  )
}

function Report({ d }: { d: any }) {
  const o = d.outcomes
  const deliveredCount = o.delivered.orders
  const lossReturns = o.returned.profit
  const lossCancels = o.cancelled.profit
  const beforeFixed = d.totals.finishedProfit - d.meta.unlinked
  const metaOk = Math.abs(d.meta.onOrders + d.meta.unlinked - d.meta.total) < 1
  const syncAcc = d.sync?.accounts?.[0]

  return (
    <>
      {/* ---------- headline ---------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Hero label={d.manager ? "Net profit" : "Profit before fixed costs"} tone={(d.manager ? d.totals.netProfit : beforeFixed) >= 0 ? "green" : "red"}
          value={<Money n={d.manager ? d.totals.netProfit : beforeFixed} sign />}
          hint={d.manager ? "after every order cost, Meta and fixed costs" : "after product, Pathao, packaging and Meta"} />
        <Hero label="Delivered sales" value={<Money n={o.delivered.revenue} />} hint={`${deliveredCount} orders delivered · ${d.totals.orders} orders in total`} />
        <Hero label="Meta spend" value={<Money n={d.meta.total} />}
          hint={<span className="inline-flex items-center gap-1">{metaOk && <Check className="size-3 text-tone-green" />}Same as Meta Ads Manager{syncAcc ? ` · ${syncAcc.name}` : ""}</span>} />
        <Hero label="Meta per delivered order" value={<Money n={deliveredCount ? d.meta.total / deliveredCount : 0} />}
          hint={`profit per delivered order: ${taka(Math.round(deliveredCount ? beforeFixed / deliveredCount : 0))}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* ---------- where the money went ---------- */}
        <section className="rounded-xl border bg-card p-5 lg:col-span-3">
          <h2 className="text-sm font-semibold">Where the money went</h2>
          <p className="mb-3 text-xs text-muted-foreground">Orders placed {d.fromDay} to {d.toDay}. Open orders are left out until they are delivered or returned.</p>
          <div className="divide-y text-sm">
            <Line label="Delivered sales" sub={`${deliveredCount} orders, money customers paid incl. delivery charge`} n={o.delivered.revenue} />
            <Line label="Product cost" sub="purchase price of the pairs delivered" n={-o.delivered.productCost} />
            <Line label="Pathao on delivered" sub="Pathao's fee per parcel (delivery + COD)" n={-o.delivered.courier} />
            <Line label="Packaging" sub={`${taka(d.packaging)} per parcel`} n={-o.delivered.packaging} />
            <Line label="Meta on delivered orders" sub={`${o.delivered.metaOrders} orders came from an ad`} n={-o.delivered.meta} />
            <Line label="Profit on delivered orders" n={o.delivered.profit} total />
            <Line label="Returned orders" sub={`${o.returned.orders} orders: Pathao ${taka(o.returned.courier)} + packaging ${taka(o.returned.packaging)} + Meta ${taka(o.returned.meta)}${o.returned.revenue ? ` − return charge paid ${taka(o.returned.revenue)}` : ""}`} n={lossReturns} />
            <Line label="Cancelled orders" sub={`${o.cancelled.orders} orders: Meta spent to bring them`} n={lossCancels} />
            <Line label="Meta spend with no order" sub="ads that brought no website order in these days" n={-d.meta.unlinked} />
            <Line label="Profit before fixed costs" n={beforeFixed} total />
            {d.manager && d.fixed && (
              <>
                <Line label="Fixed costs" sub={`salary, rent and other: ${taka(d.fixed.month)} a month, for these ${Math.round((d.to - d.from) / DAY)} days`} n={-d.fixed.period} />
                <Line label="Net profit" n={d.totals.netProfit} total big />
              </>
            )}
          </div>
        </section>

        {/* ---------- Meta check ---------- */}
        <section className="rounded-xl border bg-card p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold">Meta spend, checked against Meta</h2>
          <p className="mb-3 text-xs text-muted-foreground">Every taka Meta charged in these days, and where it went.</p>
          <div className="space-y-2 text-sm">
            {(["delivered", "returned", "cancelled", "open"] as Outcome[]).map((k) => (
              <div key={k} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2"><span className={cn("size-2 rounded-full", OUTCOME[k].dot)} />{OUTCOME[k].label} orders <span className="text-xs text-muted-foreground">({o[k].metaOrders} from ads)</span></span>
                <Money n={o[k].meta} />
              </div>
            ))}
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2"><span className="size-2 rounded-full bg-tone-amber" />No order linked</span>
              <Money n={d.meta.unlinked} />
            </div>
            <div className="flex items-center justify-between gap-2 border-t pt-2 font-semibold">
              <span>Total = Meta Ads Manager</span><Money n={d.meta.total} />
            </div>
          </div>
          <div className="mt-3 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
            <p>Website orders get the spend of the ad campaign in their link, on the day they ordered, shared equally between that campaign's orders that day. Orders the team typed in from Messenger, WhatsApp, Facebook or phone ({d.meta.chatOrders} orders) get ৳0.</p>
            {d.meta.websiteNoCampaign > 0 && <p className="mt-1.5">{d.meta.websiteNoCampaign} website orders came without a campaign in their link, so they carry no Meta cost; their ad money shows under "No order linked".</p>}
            <p className="mt-1.5">Meta data updated {d.sync?.at ? dateTime(d.sync.at) : "—"}{syncAcc?.timezone ? ` · account time ${syncAcc.timezone}` : ""}.</p>
          </div>
          {d.meta.unlinkedCampaigns.length > 0 && (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer font-medium">Campaigns with spend but no website order ({d.meta.unlinkedCampaigns.length})</summary>
              <ul className="mt-2 space-y-1">
                {d.meta.unlinkedCampaigns.map((c: any) => <li key={c.id} className="flex justify-between gap-3"><span className="truncate" title={c.name}>{c.name}</span><Money n={c.spend} /></li>)}
              </ul>
            </details>
          )}
        </section>
      </div>

      {/* ---------- by outcome ---------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(["delivered", "returned", "cancelled", "open"] as Outcome[]).map((k) => {
          const x = o[k]
          return (
            <div key={k} className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between">
                <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold", OUTCOME[k].bg, OUTCOME[k].text)}><span className={cn("size-1.5 rounded-full", OUTCOME[k].dot)} />{OUTCOME[k].label}</span>
                <span className="text-xl font-semibold tabular-nums">{x.orders}</span>
              </div>
              <dl className="mt-3 space-y-1 text-xs">
                <Row k="Meta spent" v={<Money n={x.meta} />} />
                <Row k="Meta per order" v={<Money n={x.orders ? x.meta / x.orders : 0} />} />
                <Row k="Pathao" v={<Money n={x.courier} />} />
                <Row k={k === "open" ? "Profit" : k === "delivered" ? "Profit" : "Loss"} v={k === "open" ? <span className="text-muted-foreground">when finished</span> : <Money n={x.profit} sign className="font-semibold" />} />
              </dl>
            </div>
          )
        })}
      </div>

      <Products rows={d.products} />
      <Orders rows={d.orders} />
    </>
  )
}

function Hero({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "green" | "red" }) {
  return (
    <div className={cn("rounded-xl border bg-card p-4", tone === "green" && "border-tone-green/30 bg-tone-green-bg/40", tone === "red" && "border-tone-red/30 bg-tone-red-bg/40")}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}
function Line({ label, sub, n, total, big }: { label: string; sub?: string; n: number; total?: boolean; big?: boolean }) {
  return (
    <div className={cn("flex items-center justify-between gap-4 py-2", total && "font-semibold", big && "text-base")}>
      <div className="min-w-0"><div>{label}</div>{sub && <div className="truncate text-[11px] font-normal text-muted-foreground">{sub}</div>}</div>
      <Money n={n} sign={total} className={cn(!total && n < 0 && "text-foreground/80")} />
    </div>
  )
}
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex justify-between gap-2"><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>

// ---------- products ----------
function Products({ rows }: { rows: any[] }) {
  const [sort, setSort] = useState<"profit" | "loss" | "sold">("profit")
  const [all, setAll] = useState(false)
  const sorted = useMemo(() => [...rows].sort((a, b) => sort === "profit" ? b.profit - a.profit : sort === "loss" ? a.profit - b.profit : b.delivered - a.delivered), [rows, sort])
  const shown = all ? sorted : sorted.slice(0, 15)
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
        <div><h2 className="text-sm font-semibold">By product</h2><p className="text-xs text-muted-foreground">An order's costs are shared between its pairs by price.</p></div>
        <div className="flex rounded-md border p-0.5 text-xs">
          {([["profit", "Most profit"], ["loss", "Most loss"], ["sold", "Most sold"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setSort(k)} className={cn("rounded px-2 py-0.5", sort === k ? "bg-foreground text-background" : "text-muted-foreground")}>{l}</button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b text-right">
              <th className="px-5 py-2 text-left font-medium">Product</th>
              <th className="px-3 py-2 font-medium">Delivered</th><th className="px-3 py-2 font-medium">Returned</th><th className="px-3 py-2 font-medium">Cancelled</th>
              <th className="px-3 py-2 font-medium">Sales</th><th className="px-3 py-2 font-medium">Product cost</th><th className="px-3 py-2 font-medium">Pathao + box</th>
              <th className="px-3 py-2 font-medium">Meta</th><th className="px-3 py-2 font-medium">Profit</th><th className="px-5 py-2 font-medium">Per delivered pair</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.name} className="border-b last:border-0 text-right hover:bg-muted/30">
                <td className="max-w-[320px] truncate px-5 py-2 text-left" title={p.name}>{p.name}</td>
                <td className="px-3 py-2 tabular-nums text-tone-green">{p.delivered || "—"}</td>
                <td className="px-3 py-2 tabular-nums text-tone-red">{p.returned || "—"}</td>
                <td className="px-3 py-2 tabular-nums text-muted-foreground">{p.cancelled || "—"}</td>
                <td className="px-3 py-2"><Money n={p.revenue} /></td>
                <td className="px-3 py-2"><Money n={p.productCost} /></td>
                <td className="px-3 py-2"><Money n={p.courier + p.packaging} /></td>
                <td className="px-3 py-2"><Money n={p.meta} /></td>
                <td className="px-3 py-2 font-semibold"><Money n={p.profit} sign /></td>
                <td className="px-5 py-2"><Money n={p.delivered ? p.profit / p.delivered : null} sign /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 15 && <button type="button" onClick={() => setAll(!all)} className="w-full border-t py-2 text-xs font-medium text-primary hover:bg-muted/30">{all ? "Show top 15" : `Show all ${rows.length} products`}</button>}
    </section>
  )
}

// ---------- orders ----------
function Orders({ rows }: { rows: any[] }) {
  const [tab, setTab] = useState<"all" | Outcome>("all")
  const [from, setFrom] = useState<"all" | "ads" | "chat">("all")
  const [q, setQ] = useState("")
  const [page, setPage] = useState(0)
  const filtered = useMemo(() => {
    const w = q.trim().toLowerCase()
    return rows.filter((r) => (tab === "all" || r.outcome === tab)
      && (from === "all" || (from === "ads" ? r.meta > 0 : r.source !== "Website"))
      && (!w || `${r.invoice} ${r.customer} ${r.items.join(" ")} ${r.campaign ?? ""}`.toLowerCase().includes(w)))
  }, [rows, tab, from, q])
  const per = 50
  const shown = filtered.slice(page * per, page * per + per)
  const count = (k: "all" | Outcome) => k === "all" ? rows.length : rows.filter((r) => r.outcome === k).length
  const sum = (k: string) => filtered.reduce((t, r) => t + (r[k] ?? 0), 0)

  return (
    <section className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div><h2 className="text-sm font-semibold">Order by order</h2><p className="text-xs text-muted-foreground">Real figures: Pathao's own fee, the purchase price of each size, and the Meta campaign that brought the order.</p></div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} placeholder="Order, customer, product, campaign" className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2 text-sm" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
        {(["all", "delivered", "returned", "cancelled", "open"] as const).map((k) => (
          <button key={k} type="button" onClick={() => { setTab(k); setPage(0) }} className={cn("rounded-full border px-2.5 py-0.5 text-xs", tab === k ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:bg-accent")}>
            {k === "all" ? "All" : OUTCOME[k].label} <span className="opacity-70">{count(k)}</span>
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        {([["all", "Any source"], ["ads", "From Meta ads"], ["chat", "Chat & phone (৳0 Meta)"]] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => { setFrom(k); setPage(0) }} className={cn("rounded-full border px-2.5 py-0.5 text-xs", from === k ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:bg-accent")}>{l}</button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b text-right">
              <th className="px-5 py-2 text-left font-medium">Order</th><th className="px-3 py-2 text-left font-medium">Products</th><th className="px-3 py-2 text-left font-medium">Came from</th>
              <th className="px-3 py-2 text-left font-medium">Status</th><th className="px-3 py-2 font-medium">Sales</th><th className="px-3 py-2 font-medium">Product</th>
              <th className="px-3 py-2 font-medium">Pathao</th><th className="px-3 py-2 font-medium">Box</th><th className="px-3 py-2 font-medium">Meta</th><th className="px-5 py-2 font-medium">Profit</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-b align-top last:border-0 text-right hover:bg-muted/30">
                <td className="whitespace-nowrap px-5 py-2 text-left">
                  <Link to="/order" search={{ id: r.id }} className="font-semibold text-tone-blue hover:underline">{r.invoice}</Link>
                  <div className="text-[11px] text-muted-foreground">{dateTime(r.createdAt)}</div>
                </td>
                <td className="max-w-[260px] px-3 py-2 text-left">
                  {r.items.map((i: string, k: number) => <div key={k} className="truncate" title={i}>{i}</div>)}
                  <div className="text-[11px] text-muted-foreground">{r.customer}</div>
                </td>
                <td className="max-w-[200px] px-3 py-2 text-left text-xs">
                  {r.campaign ? <><div className="truncate font-medium" title={r.campaign}>{r.campaign}</div><div className="text-muted-foreground">Meta ad</div></>
                    : <><div>{r.source}</div><div className="text-muted-foreground">{r.source === "Website" ? (r.campaignTag ? "link not in Meta" : "no campaign in link") : "typed in by team"}</div></>}
                </td>
                <td className="px-3 py-2 text-left"><StatusPill status={r.status} /></td>
                <td className="px-3 py-2"><Money n={r.outcome === "delivered" || r.revenue ? r.revenue : null} />{r.outcome !== "delivered" && <div className="text-[11px] text-muted-foreground">order {taka(r.value)}</div>}</td>
                <td className="px-3 py-2">{r.cogs ? <Money n={r.cogs} /> : <span className="text-muted-foreground">{r.outcome === "returned" ? "back in stock" : "—"}</span>}{r.costMissing && <div className="text-[11px] text-tone-amber">price missing</div>}</td>
                <td className="px-3 py-2">{r.courier ? <Money n={r.courier} /> : <span className="text-muted-foreground">—</span>}{r.courierNote === "booked" && <div className="text-[11px] text-tone-amber">not invoiced yet</div>}</td>
                <td className="px-3 py-2">{r.packaging ? <Money n={r.packaging} /> : <span className="text-muted-foreground">—</span>}</td>
                <td className="px-3 py-2">{r.meta ? <Money n={r.meta} /> : <span className="text-muted-foreground">৳0</span>}</td>
                <td className="px-5 py-2 font-semibold">{r.profit === null ? <span className="text-xs font-normal text-muted-foreground">open</span> : <Money n={r.profit} sign />}</td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={10} className="px-5 py-8 text-center text-sm text-muted-foreground">No orders here.</td></tr>}
          </tbody>
          {filtered.length > 0 && (
            <tfoot>
              <tr className="border-t bg-muted/40 text-right text-xs font-semibold">
                <td className="px-5 py-2 text-left" colSpan={4}>{filtered.length} orders</td>
                <td className="px-3 py-2"><Money n={sum("revenue")} /></td><td className="px-3 py-2"><Money n={sum("cogs")} /></td>
                <td className="px-3 py-2"><Money n={sum("courier")} /></td><td className="px-3 py-2"><Money n={sum("packaging")} /></td>
                <td className="px-3 py-2"><Money n={sum("meta")} /></td><td className="px-5 py-2"><Money n={sum("profit")} sign /></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {filtered.length > per && (
        <div className="flex items-center justify-between border-t px-5 py-2 text-xs">
          <span className="text-muted-foreground">{page * per + 1}–{Math.min(filtered.length, page * per + per)} of {filtered.length}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={(page + 1) * per >= filtered.length} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        </div>
      )}
    </section>
  )
}

function downloadCsv(d: any) {
  const head = ["Order", "Date", "Customer", "Products", "Source", "Campaign", "Status", "Order value", "Sales", "Product cost", "Pathao", "Packaging", "Meta", "Profit"]
  const esc = (x: unknown) => `"${String(x ?? "").replace(/"/g, '""')}"`
  const lines = d.orders.map((r: any) => [r.invoice, bdDate(r.createdAt), r.customer, r.items.join(" | "), r.source, r.campaign ?? "", r.status, r.value, r.revenue, r.cogs, r.courier, r.packaging, r.meta, r.profit ?? ""].map(esc).join(","))
  const blob = new Blob([[head.map(esc).join(","), ...lines].join("\n")], { type: "text/csv" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = `profit-${d.fromDay}-to-${d.toDay}.csv`
  a.click()
}
