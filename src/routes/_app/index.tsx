import { useMemo, useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { ArrowDownRight, ArrowUpRight, Minus, Truck, Wallet } from "lucide-react"
import { usePolledAction } from "@/lib/use-polled-action"
import { api } from "@/convex/_generated/api"
import { Guard } from "@/components/app-shell"
import { Loading, StatusPill } from "@/components/bits"
import { dateOnly, startOfDayBD, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/")({
  component: () => (
    <Guard perm="dashboard.view">
      <Dashboard />
    </Guard>
  ),
})

const RANGES = [
  { key: "today", label: "Today", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
]

const QUEUE = [
  { tab: "pending", label: "Pending", sub: "call & confirm", cls: "bg-tone-amber-bg text-tone-amber" },
  { tab: "on_hold", label: "On hold", sub: "waiting on customer", cls: "bg-tone-orange-bg text-tone-orange" },
  { tab: "approved", label: "Approved", sub: "to print & pack", cls: "bg-tone-blue-bg text-tone-blue" },
  { tab: "processing", label: "Processing", sub: "packing now", cls: "bg-tone-violet-bg text-tone-violet" },
  { tab: "ready_to_ship", label: "Ready to ship", sub: "waiting for pickup", cls: "bg-tone-indigo-bg text-tone-indigo" },
  { tab: "in_transit", label: "With courier", sub: "on the way", cls: "bg-tone-cyan-bg text-tone-cyan" },
]

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0)
const change = (now: number, prev: number) => (prev ? Math.round(((now - prev) / prev) * 100) : now ? 100 : 0)

function Dashboard() {
  const [range, setRange] = useState("30d")
  const days = RANGES.find((r) => r.key === range)!.days
  const { from, to } = useMemo(() => ({ from: startOfDayBD() - (days - 1) * 86400000, to: startOfDayBD() + 86400000 - 1 }), [days])
  const data = usePolledAction(api.dashboard.overview, { from, to }, 60000)
  const counts = useQuery(api.orders.counts)
  const n = data?.now, p = data?.prev, pa = data?.pathao, m = data?.money
  const label = RANGES.find((r) => r.key === range)!.label.toLowerCase()

  // health signal: delivery % from Pathao when available, else our own
  const deliveryPct = pa?.total?.count ? pa.delivered.pct : n?.deliveryRate ?? null
  const returnPct = pa?.total?.count ? pa.returned.pct : n && n.delivered + n.returned ? pct(n.returned, n.delivered + n.returned) : null
  const health = deliveryPct === null ? null : deliveryPct >= 80 ? { t: "Healthy", c: "text-tone-green", bg: "bg-tone-green-bg" } : deliveryPct >= 65 ? { t: "Watch returns", c: "text-tone-amber", bg: "bg-tone-amber-bg" } : { t: "High returns — act", c: "text-tone-red", bg: "bg-tone-red-bg" }

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Business at a glance</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Sales, deliveries, returns and money — {label === "today" ? "today" : `last ${label}`}, compared with the {label === "today" ? "day" : "period"} before.</p>
        </div>
        <div className="flex items-center gap-3">
          {health && <span className={cn("rounded-full px-3 py-1 text-sm font-semibold", health.bg, health.c)}>● {health.t}</span>}
          <div className="flex rounded-lg border bg-card p-1">
            {RANGES.map((r) => (
              <button key={r.key} type="button" onClick={() => setRange(r.key)}
                className={cn("rounded-md px-3.5 py-1.5 text-sm font-medium", range === r.key ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent")}>{r.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* today's work */}
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Today's work</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {QUEUE.map((q) => (
            <Link key={q.tab} to="/orders" search={{ tab: q.tab }} className={cn("group rounded-xl p-4 transition hover:-translate-y-0.5 hover:shadow-md", q.cls)}>
              <div className="text-sm font-semibold">{q.label}</div>
              <div className="mt-1 text-3xl font-bold tabular-nums">{counts?.[q.tab] ?? "·"}</div>
              <div className="mt-0.5 text-xs opacity-80">{q.sub} →</div>
            </Link>
          ))}
        </div>
      </section>

      {!data || !n ? <Loading /> : (
        <>
          {/* headline numbers */}
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Hero label="Sales" value={taka(n.totalSales)} delta={change(n.totalSales, p?.totalSales ?? 0)} sub={`${n.totalOrders} orders · avg ${taka(n.avgOrder)}`} tone="blue" />
            <Hero label="Delivered value" value={taka(n.deliveredValue)} delta={change(n.deliveredValue, p?.deliveredValue ?? 0)} sub={`${n.delivered} orders delivered`} tone="green" />
            <Gauge label="Delivery success" value={deliveryPct} sub={pa?.total?.count ? `Pathao · ${pa.delivered.count} of ${pa.total.count} parcels` : "Our orders · delivered vs returned"} good />
            <Gauge label="Return rate" value={returnPct} sub={pa?.total?.count ? `Pathao · ${pa.returned.count} parcels returned` : `${n.returned} orders returned`} />
          </section>

          <div className="grid gap-4 lg:grid-cols-3">
            {/* trend */}
            <section className="rounded-xl border bg-card p-4 lg:col-span-2">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Orders by day — what happened to them</h2>
                <span className="text-xs text-muted-foreground">{n.totalOrders} orders · {n.cancelled} cancelled</span>
              </div>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  {n.daily.length > 1 ? (
                    <BarChart data={n.daily.map((d: any) => ({ ...d, label: d.day.slice(5) }))} margin={{ left: -18, right: 6 }}>
                      <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} stroke="hsl(var(--muted-foreground))" interval="preserveStartEnd" />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip cursor={{ fill: "hsl(var(--muted))" }} contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 10, fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
                      <Bar dataKey="delivered" name="Delivered" stackId="a" fill="hsl(var(--tone-green))" />
                      <Bar dataKey="open" name="Still open" stackId="a" fill="hsl(var(--tone-blue))" />
                      <Bar dataKey="returned" name="Returned" stackId="a" fill="hsl(var(--tone-red))" />
                      <Bar dataKey="cancelled" name="Cancelled" stackId="a" fill="hsl(var(--tone-gray))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  ) : (
                    <AreaChart data={[{ label: "start", sales: 0 }, { label: "today", sales: n.totalSales }]}>
                      <Area dataKey="sales" stroke="hsl(var(--tone-blue))" fill="hsl(var(--tone-blue-bg))" />
                    </AreaChart>
                  )}
                </ResponsiveContainer>
              </div>
            </section>

            {/* Pathao outcome */}
            <section className="rounded-xl border bg-card p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold"><Truck className="size-4" /> Pathao parcels</h2>
                {pa?.cachedAt && <span className="text-[11px] text-muted-foreground">Pathao · {new Date(pa.cachedAt).toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour: "numeric", minute: "2-digit" })}</span>}
              </div>
              {!pa ? <p className="text-sm text-muted-foreground">Couldn't reach Pathao right now.</p> : (
                <>
                  <div className="mb-3 flex h-3 overflow-hidden rounded-full bg-muted">
                    <div className="bg-tone-green" style={{ width: `${pa.delivered.pct}%` }} title="Delivered" />
                    <div className="bg-tone-red" style={{ width: `${pa.returned.pct}%` }} title="Returned" />
                  </div>
                  <OutcomeRow label="Total parcels" c={pa.total} strong />
                  <OutcomeRow label="Delivered" c={pa.delivered} tone="text-tone-green" />
                  <OutcomeRow label="Returned (all)" c={pa.returned} tone="text-tone-red" />
                  <div className="ml-3 border-l pl-3">
                    <OutcomeRow label="Regular return" c={pa.returns.regular} small />
                    <OutcomeRow label="Paid return" c={pa.returns.paid} small />
                    <OutcomeRow label="Partial delivery" c={pa.returns.partial} small />
                    <OutcomeRow label="Exchange" c={pa.returns.exchange} small />
                  </div>
                  <div className="mt-2 border-t pt-2">
                    <OutcomeRow label="On hold" c={pa.moving.onHold} tone="text-tone-orange" />
                    <OutcomeRow label="On the way / at hub" c={{ count: pa.moving.inTransit.count + pa.moving.assigned.count + pa.moving.atDeliveryHub.count, amount: pa.moving.inTransit.amount + pa.moving.assigned.amount + pa.moving.atDeliveryHub.amount, pct: pa.moving.inTransit.pct + pa.moving.assigned.pct + pa.moving.atDeliveryHub.pct }} />
                    <OutcomeRow label="Coming back" c={{ count: pa.moving.returnInTransit.count + pa.moving.returnAssigned.count + pa.moving.atReturnHub.count, amount: pa.moving.returnInTransit.amount + pa.moving.returnAssigned.amount + pa.moving.atReturnHub.amount, pct: pa.moving.returnInTransit.pct + pa.moving.returnAssigned.pct + pa.moving.atReturnHub.pct }} />
                  </div>
                </>
              )}
            </section>
          </div>

          {/* money */}
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Money label="Pathao paid us" value={taka(m?.paidToUs ?? 0)} sub={`${m?.invoices ?? 0} invoices in these dates`} tone="green" />
            <Money label="Waiting from Pathao" value={taka(Math.max(0, m?.waitingAmount ?? 0))} sub={`${m?.waitingCount ?? 0} delivered parcels not paid yet`} tone="amber" />
            <Money label="Pathao fees" value={taka(m?.fees ?? 0)} sub={m?.collected ? `${pct(m.fees, m.collected)}% of ${taka(m.collected)} collected` : "delivery + COD fees"} tone="red" />
            <Money label="Last payout" value={m?.lastInvoice ? taka(m.lastInvoice.amount) : "—"} sub={m?.lastInvoice ? `${dateOnly(m.lastInvoice.at)} · ${m.lastInvoice.status}` : "Sync in Pathao payments"} tone="blue" link />
          </section>

          <div className="grid gap-4 lg:grid-cols-3">
            <section className="rounded-xl border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Orders by status (this period)</h2>
              <div className="space-y-2">
                {(Object.entries(n.byStatus) as [string, number][]).sort((a, b) => b[1] - a[1]).map(([s, c]) => (
                  <div key={s} className="flex items-center gap-3 text-sm">
                    <span className="w-32 shrink-0"><StatusPill status={s} /></span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-foreground/60" style={{ width: `${pct(c, n.totalOrders + n.cancelled)}%` }} /></div>
                    <span className="w-8 text-right tabular-nums">{c}</span>
                  </div>
                ))}
                {Object.keys(n.byStatus).length === 0 && <p className="text-sm text-muted-foreground">No orders in this period.</p>}
              </div>
            </section>

            <section className="rounded-xl border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Where orders come from</h2>
              <div className="space-y-2.5">
                {n.bySource.map((s: any) => (
                  <div key={s.source} className="text-sm">
                    <div className="flex justify-between"><span className="font-medium">{s.source}</span><span className="tabular-nums text-muted-foreground">{s.count} · {taka(s.value)}</span></div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-tone-violet" style={{ width: `${pct(s.count, n.totalOrders)}%` }} /></div>
                  </div>
                ))}
                {n.bySource.length === 0 && <p className="text-sm text-muted-foreground">No orders yet.</p>}
              </div>
            </section>

            <section className="rounded-xl border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Top selling items</h2>
              <ol className="space-y-2">
                {n.topItems.map((i: any, k: number) => (
                  <li key={i.sku} className="flex items-center gap-3 text-sm">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{k + 1}</span>
                    <div className="min-w-0 flex-1"><div className="truncate">{i.name}</div><div className="truncate font-mono text-[11px] text-muted-foreground">{i.sku}</div></div>
                    <div className="text-right"><div className="font-semibold tabular-nums">{i.qty}</div><div className="text-[11px] text-muted-foreground tabular-nums">{taka(i.value)}</div></div>
                  </li>
                ))}
                {n.topItems.length === 0 && <p className="text-sm text-muted-foreground">No sales yet.</p>}
              </ol>
            </section>
          </div>
        </>
      )}
    </div>
  )
}

const HERO: Record<string, string> = { blue: "from-tone-blue-bg", green: "from-tone-green-bg" }
function Hero({ label, value, delta, sub, tone }: { label: string; value: string; delta: number; sub: string; tone: string }) {
  const Icon = delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : Minus
  return (
    <div className={cn("rounded-xl border bg-gradient-to-br to-card p-4", HERO[tone])}>
      <div className="flex items-center justify-between text-sm font-medium text-muted-foreground">
        <span>{label}</span>
        <span className={cn("inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold", delta > 0 ? "bg-tone-green-bg text-tone-green" : delta < 0 ? "bg-tone-red-bg text-tone-red" : "bg-muted text-muted-foreground")}>
          <Icon className="size-3.5" />{Math.abs(delta)}%
        </span>
      </div>
      <div className="mt-1.5 text-3xl font-bold tabular-nums tracking-tight">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub} · vs previous period</div>
    </div>
  )
}

function Gauge({ label, value, sub, good }: { label: string; value: number | null; sub: string; good?: boolean }) {
  const v = value ?? 0
  const ok = good ? v >= 80 : v <= 15
  const mid = good ? v >= 65 : v <= 25
  const color = value === null ? "hsl(var(--muted-foreground))" : ok ? "hsl(var(--tone-green))" : mid ? "hsl(var(--tone-amber))" : "hsl(var(--tone-red))"
  const r = 26, c = 2 * Math.PI * r
  return (
    <div className="flex items-center gap-4 rounded-xl border bg-card p-4">
      <svg viewBox="0 0 64 64" className="size-20 shrink-0 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth="7" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(Math.min(100, v) / 100) * c} ${c}`} />
      </svg>
      <div className="min-w-0">
        <div className="text-sm font-medium text-muted-foreground">{label}</div>
        <div className="text-3xl font-bold tabular-nums" style={{ color }}>{value === null ? "—" : `${v}%`}</div>
        <div className="text-xs text-muted-foreground">{sub}</div>
      </div>
    </div>
  )
}

function OutcomeRow({ label, c, tone, strong, small }: { label: string; c: { count: number; amount: number; pct: number }; tone?: string; strong?: boolean; small?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-2 py-1", small ? "text-xs text-muted-foreground" : "text-sm")}>
      <span className={cn(strong && "font-semibold")}>{label}</span>
      <span className="flex items-baseline gap-2 tabular-nums">
        <span className={cn("font-semibold", tone)}>{c.count}</span>
        {!strong && <span className={cn("w-12 text-right text-xs", tone ?? "text-muted-foreground")}>{Math.round(c.pct * 10) / 10}%</span>}
        <span className="w-20 text-right text-xs text-muted-foreground">{taka(c.amount)}</span>
      </span>
    </div>
  )
}

const MONEY: Record<string, string> = { green: "border-l-tone-green text-tone-green", amber: "border-l-tone-amber text-tone-amber", red: "border-l-tone-red text-tone-red", blue: "border-l-tone-blue text-tone-blue" }
function Money({ label, value, sub, tone, link }: { label: string; value: string; sub: string; tone: string; link?: boolean }) {
  const [border, text] = MONEY[tone].split(" ")
  const body = (
    <div className={cn("h-full rounded-xl border border-l-4 bg-card p-4 transition", border, link && "hover:shadow-md")}>
      <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground"><Wallet className="size-3.5" />{label}</div>
      <div className={cn("mt-1 text-2xl font-bold tabular-nums", text)}>{value}</div>
      <div className="mt-0.5 text-xs capitalize-first text-muted-foreground">{sub}</div>
    </div>
  )
  return link ? <Link to="/courier-payments">{body}</Link> : body
}
