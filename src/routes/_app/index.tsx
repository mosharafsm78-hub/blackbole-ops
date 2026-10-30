import { useMemo, useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useAction, useQuery } from "convex/react"
import { useEffect } from "react"
import { ArrowDownRight, ArrowUpRight, ChevronDown, Minus, PhoneCall, ShieldAlert, Target, Undo2 } from "lucide-react"
import { usePolledAction } from "@/lib/use-polled-action"
import { api } from "@/convex/_generated/api"
import { Guard } from "@/components/app-shell"
import { RevenueTargetCard } from "@/components/revenue-target-card"
import { ContactButtons, Loading, StatusPill, TeamTag } from "@/components/bits"
import { startOfDayBD, taka } from "@/lib/format"
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
  { tab: "pending", label: "Pending", sub: "call & confirm", cls: "bg-tone-amber-bg text-tone-amber", team: "Customer Care" },
  { tab: "on_hold", label: "On hold", sub: "waiting on customer", cls: "bg-tone-orange-bg text-tone-orange", team: "Customer Care" },
  { tab: "approved", label: "Approved", sub: "to print & pack", cls: "bg-tone-blue-bg text-tone-blue", team: "Fulfillment" },
  { tab: "processing", label: "Processing", sub: "packing now", cls: "bg-tone-violet-bg text-tone-violet", team: "Fulfillment" },
  { tab: "pre_order", label: "Pre-Order", sub: "waiting for product", cls: "bg-tone-pink-bg text-tone-pink", team: "Fulfillment" },
  { tab: "ready_to_ship", label: "Ready to ship", sub: "waiting for pickup", cls: "bg-tone-indigo-bg text-tone-indigo", team: "Fulfillment" },
  { tab: "in_transit", label: "With courier", sub: "on the way", cls: "bg-tone-cyan-bg text-tone-cyan", team: "Fulfillment" },
]


const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0)
const change = (now: number, prev: number) => (prev ? Math.round(((now - prev) / prev) * 100) : now ? 100 : 0)

function Dashboard() {
  const [range, setRange] = useState("30d")
  const days = RANGES.find((r) => r.key === range)!.days
  const { from, to } = useMemo(() => ({ from: startOfDayBD() - (days - 1) * 86400000, to: startOfDayBD() + 86400000 - 1 }), [days])
  const data = usePolledAction(api.dashboard.overview, { from, to }, 5 * 60000)
  const counts = useQuery(api.orders.counts)
  const urgency = useQuery(api.orders.urgency)
  const flagCounts = useQuery(api.accountability.openCounts)
  // Hidden admin check (?check=1): old count vs daily scoreboard for 7/30/90/365 days
  const compare = useAction(api.dashboard.compareStats)
  const [check, setCheck] = useState<any>(null)
  useEffect(() => {
    if (typeof window === "undefined" || !new URLSearchParams(window.location.search).has("check")) return
    void (async () => {
      const out: any = {}
      for (const d of [7, 30, 90, 365]) {
        try { out[d] = await compare({ from: startOfDayBD() - (d - 1) * 86400000, to: startOfDayBD() + 86400000 - 1 }) } catch (e) { out[d] = String(e) }
      }
      setCheck(out)
    })()
  }, [compare])
  const n = data?.now, p = data?.prev, pa = data?.pathao, m = data?.money
  const label = RANGES.find((r) => r.key === range)!.label.toLowerCase()

  // health signal: delivery % from Pathao when available, else our own
  const deliveryPct = pa?.total?.count ? pa.delivered.pct : n?.deliveryRate ?? null
  const returnPct = pa?.total?.count ? pa.returned.pct : n && n.delivered + n.returned ? pct(n.returned, n.delivered + n.returned) : null
  const health = deliveryPct === null ? null : deliveryPct >= 80 ? { t: "Healthy", c: "text-tone-green", bg: "bg-tone-green-bg" } : deliveryPct >= 65 ? { t: "Watch returns", c: "text-tone-amber", bg: "bg-tone-amber-bg" } : { t: "High returns — act", c: "text-tone-red", bg: "bg-tone-red-bg" }

  if (check) return <pre className="whitespace-pre-wrap p-4 text-xs" data-testid="stats-check">{JSON.stringify(check, null, 1)}</pre>
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

      <BusinessInsights />

      <RevenueTargetCard />

      {/* today's work */}
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Today's work</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          {QUEUE.map((q) => (
            <Link key={q.tab} to="/orders" search={{ tab: q.tab }} className={cn("group rounded-xl p-4 transition hover:-translate-y-0.5 hover:shadow-md", q.cls)}>
              <div className="flex items-center justify-between gap-1.5">
                <div className="truncate text-sm font-semibold">{q.label}</div>
                <TeamTag team={q.team} />
              </div>
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
            {/* Urgency — what customer care and their supervisor should feel pressure about, right now */}
            <section className="rounded-xl border bg-card p-4 lg:col-span-2">
              <div className="mb-1 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold">Needs attention now</h2>
                <span className="text-xs text-muted-foreground">Updates live</span>
              </div>
              <p className="mb-3 text-xs text-muted-foreground">Every one of these is a customer waiting on us. Click through to work the list.</p>
              {!urgency ? <Loading /> : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <Link to="/orders" search={{ tab: "pending" }} className="group rounded-xl bg-tone-amber-bg p-4 text-tone-amber transition hover:-translate-y-0.5 hover:shadow-md">
                    <div className="flex items-center justify-between"><Target className="size-4 opacity-70" /><TeamTag team="Customer Care" /></div>
                    <div className="mt-2 text-3xl font-bold tabular-nums">{urgency.pendingOrders}</div>
                    <div className="mt-0.5 text-xs opacity-80">Pending orders →</div>
                  </Link>
                  <Link to="/accountability" search={{ tab: "open" }} className={cn("group rounded-xl p-4 transition hover:-translate-y-0.5 hover:shadow-md", (flagCounts?.total ?? 0) > 0 ? "bg-tone-red/10 text-tone-red" : "bg-tone-green-bg text-tone-green")}>
                    <div className="flex items-center justify-between"><ShieldAlert className="size-4 opacity-70" /></div>
                    <div className="mt-2 text-3xl font-bold tabular-nums">{flagCounts?.total ?? 0}</div>
                    <div className="mt-0.5 text-xs opacity-80">Accountability open →</div>
                  </Link>
                  <Link to="/orders" search={{ tab: "all", flag: "needsFeedback" }} className={cn("group rounded-xl p-4 transition hover:-translate-y-0.5 hover:shadow-md", urgency.feedbackPending > 0 ? "bg-tone-red/10 text-tone-red" : "bg-tone-green-bg text-tone-green")}>
                    <div className="flex items-center justify-between"><PhoneCall className="size-4 opacity-70" /><TeamTag team="Customer Care" /></div>
                    <div className="mt-2 text-3xl font-bold tabular-nums">{urgency.feedbackPending}</div>
                    <div className="mt-0.5 text-xs opacity-80">Feedback calls pending →</div>
                  </Link>
                  <Link to="/orders" search={{ tab: "all", flag: "csatFollowUp" }} className={cn("group rounded-xl p-4 transition hover:-translate-y-0.5 hover:shadow-md", urgency.feedbackFollowUp > 0 ? "bg-tone-red/10 text-tone-red" : "bg-tone-green-bg text-tone-green")}>
                    <div className="flex items-center justify-between"><PhoneCall className="size-4 opacity-70" /><TeamTag team="Customer Care" /></div>
                    <div className="mt-2 text-3xl font-bold tabular-nums">{urgency.feedbackFollowUp}</div>
                    <div className="mt-0.5 text-xs opacity-80">Feedback follow-ups due →</div>
                  </Link>
                  <Link to="/orders" search={{ tab: "all", flag: "needsReason" }} className={cn("group rounded-xl p-4 transition hover:-translate-y-0.5 hover:shadow-md", urgency.reasonsPending > 0 ? "bg-tone-red/10 text-tone-red" : "bg-tone-green-bg text-tone-green")}>
                    <div className="flex items-center justify-between"><Undo2 className="size-4 opacity-70" /><TeamTag team="Customer Care" /></div>
                    <div className="mt-2 text-3xl font-bold tabular-nums">{urgency.reasonsPending}</div>
                    <div className="mt-0.5 text-xs opacity-80">Return reasons pending →</div>
                  </Link>
                </div>
              )}
            </section>

            {/* Today */}
            <section className="flex flex-col rounded-xl border bg-gradient-to-br from-tone-violet-bg to-card p-4" data-testid="today-box">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Today</h2>
                <span className="text-xs text-muted-foreground">{new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka", weekday: "short", day: "numeric", month: "short" })}</span>
              </div>
              {(() => {
                const t = data.today, y = data.yesterday
                if (!t) return null
                const d1 = change(t.totalOrders, y?.totalOrders ?? 0), d2 = change(t.totalSales, y?.totalSales ?? 0)
                return (
                  <>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <div>
                        <div className="text-xs text-muted-foreground">Orders received</div>
                        <div className="text-4xl font-bold tabular-nums">{t.totalOrders}</div>
                        <Delta v={d1} />
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Order value</div>
                        <div className="text-2xl font-bold tabular-nums leading-[2.5rem]">{taka(t.totalSales)}</div>
                        <Delta v={d2} />
                      </div>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">Compared with yesterday up to this time ({y?.totalOrders ?? 0} orders, {taka(y?.totalSales ?? 0)}).</p>
                    <div className="mt-auto grid grid-cols-3 gap-2 border-t pt-3 text-center text-xs">
                      <div><div className="text-lg font-semibold tabular-nums">{t.totalOrders ? taka(t.avgOrder) : "—"}</div><div className="text-muted-foreground">Avg order</div></div>
                      <div><div className="text-lg font-semibold tabular-nums text-tone-green">{t.delivered}</div><div className="text-muted-foreground">Delivered today</div></div>
                      <div><div className="text-lg font-semibold tabular-nums text-tone-gray">{t.cancelled}</div><div className="text-muted-foreground">Cancelled</div></div>
                    </div>
                  </>
                )
              })()}
            </section>
          </div>

          <Birthdays />

          <MonthlySummary />

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

function Delta({ v }: { v: number }) {
  const Icon = v > 0 ? ArrowUpRight : v < 0 ? ArrowDownRight : Minus
  return <span className={cn("mt-0.5 inline-flex items-center gap-0.5 text-xs font-semibold", v > 0 ? "text-tone-green" : v < 0 ? "text-tone-red" : "text-muted-foreground")}><Icon className="size-3.5" />{Math.abs(v)}% vs yesterday</span>
}

/** A tiny, specific corner: the biggest money-losing problem (or growth lever) the data points to, and exactly what to do about it. */
function BusinessInsights() {
  const data = usePolledAction(api.dashboard.insights, {}, 15 * 60000)
  const [open, setOpen] = useState(false)
  if (!data || data.findings.length === 0) return null
  const [top, ...rest] = data.findings
  return (
    <section className="rounded-xl border border-tone-violet/30 bg-gradient-to-br from-tone-violet-bg to-card p-4" data-testid="business-insights">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-tone-violet/15 text-tone-violet"><Target className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{top.problem}</h2>
            <span className="shrink-0 rounded-full bg-tone-violet/10 px-2 py-0.5 text-[11px] font-semibold text-tone-violet">Biggest lever · last {data.windowDays}d</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{top.finding}</p>
          <p className="mt-2 rounded-lg bg-card/70 px-3 py-2 text-sm"><span className="font-semibold text-tone-violet">{top.status === "automatic" ? "What it does: " : "Do this: "}</span>{top.solution}</p>
          <div className="mt-2 flex items-center gap-3 text-xs font-medium">
            {rest.length > 0 && (
              <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                <ChevronDown className={cn("size-3.5 transition", open && "rotate-180")} />
                {open ? "Hide" : `${rest.length} more thing${rest.length > 1 ? "s" : ""} worth fixing`}
              </button>
            )}
            <Link to="/action-center" className="text-tone-violet hover:underline">Open Action Center →</Link>
          </div>
          {open && rest.length > 0 && (
            <div className="mt-2 space-y-2 border-t pt-2">
              {rest.map((f: any) => (
                <div key={f.id} className="text-sm">
                  <div className="font-semibold">{f.problem}</div>
                  <p className="text-muted-foreground">{f.finding}</p>
                  <p className="mt-1 rounded-lg bg-card/70 px-3 py-2"><span className="font-semibold text-tone-violet">{f.status === "automatic" ? "What it does: " : "Do this: "}</span>{f.solution}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/** Month by month — the business over time. */
/** Today's birthdays (Asia/Dhaka) — customers who gave a date of birth on the order form. A small, honest panel:
 *  it never nags when the list is empty, but it's always in the same place so checking it becomes a habit.
 *  Email and SMS go out automatically every day at 10am (see convex/crons.ts); WhatsApp is drafted and queued
 *  for a human tap (WhatsApp tab) to stay clear of automation bans. Customer Care can still open a row here to
 *  send (or resend) a personalized email on top of the automatic one. */
function Birthdays() {
  const rows = useQuery(api.birthdays.today, {})
  const [openId, setOpenId] = useState<string | null>(null)
  if (rows && rows.length === 0) return <p className="text-xs text-muted-foreground">🎂 No customer birthdays today.</p>
  return (
    <section className="rounded-xl border bg-gradient-to-br from-tone-pink-bg to-card p-4">
      <h2 className="mb-3 text-sm font-semibold">🎂 Birthdays today</h2>
      {!rows ? <Loading /> : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((c: any) => (
            <BirthdayRow key={c._id} c={c} open={openId === c._id} onToggle={() => setOpenId(openId === c._id ? null : c._id)} />
          ))}
        </div>
      )}
    </section>
  )
}

function BirthdayRow({ c, open, onToggle }: { c: any; open: boolean; onToggle: () => void }) {
  const sendEmail = useAction(api.emailNode.sendBirthdayEmail)
  const [subject, setSubject] = useState(`Happy Birthday, ${c.name}! 🎉`)
  const [body, setBody] = useState(
    `Hi ${c.name},\n\nWishing you a very happy birthday from all of us at BlackBole! 🎂 We hope your day is full of good moments.\n\nAs a small birthday gift, here's ৳500 off your next order — just use the code BDAYGIFT500 at checkout (on orders ৳2500+).\n\nWarm wishes,\nTeam BlackBole`,
  )
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSent, setJustSent] = useState(false)

  const send = async () => {
    setSending(true)
    setError(null)
    try {
      const res = await sendEmail({ customerId: c._id, subject, text: body })
      if (res.ok) {
        setJustSent(true)
        onToggle()
      } else setError(res.error || "Couldn't send")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{c.name}{c.turning ? <span className="ml-1 font-normal text-muted-foreground">· turning {c.turning}</span> : null}</div>
          <div className="font-mono text-xs text-muted-foreground">{c.phone}</div>
          {c.email ? <div className="truncate text-xs text-muted-foreground">{c.email}</div> : <div className="text-xs text-muted-foreground/70">No email on file</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ContactButtons phone={c.phone} />
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className={c.birthdayEmailAt || justSent ? "text-emerald-600" : ""}>✉️ Email {c.birthdayEmailAt || justSent ? "sent ✓" : "— due at 10am"}</span>
        <span className={c.birthdaySmsAt ? "text-emerald-600" : ""}>💬 SMS {c.birthdaySmsAt ? "sent ✓" : "— due at 10am"}</span>
        <span className={c.birthdayWaQueuedAt ? "text-emerald-600" : ""}>🟢 WhatsApp {c.birthdayWaQueuedAt ? "queued ✓ (tap to send)" : "— due at 10am"}</span>
        {c.email && (
          <button type="button" onClick={onToggle} className="rounded-md border px-1.5 py-0.5 text-xs font-medium hover:bg-muted">
            {open ? "Cancel" : "Send/resend email"}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-2 border-t pt-2">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            placeholder="Subject"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            placeholder="Message — add a personal touch before sending"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <button
            type="button"
            disabled={sending}
            onClick={send}
            className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-60"
          >
            {sending ? "Sending…" : "Send email"}
          </button>
        </div>
      )}
    </div>
  )
}

function MonthlySummary() {
  const [months, setMonths] = useState(6)
  const rows = usePolledAction(api.dashboard.monthly, { months }, 15 * 60000)
  const max = Math.max(1, ...(rows ?? []).map((r: any) => r.sales))
  const fmtMonth = (k: string) => new Date(`${k}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })
  return (
    <section className="rounded-xl border bg-card" data-testid="monthly-summary">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Monthly summary</h2>
        <div className="flex rounded-md border p-0.5 text-xs">
          {[3, 6, 12].map((m) => (
            <button key={m} type="button" onClick={() => setMonths(m)} className={cn("rounded px-2.5 py-1", months === m ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent")}>{m} months</button>
          ))}
        </div>
      </div>
      {!rows ? <Loading /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="px-4 py-2.5 font-medium">Month</th>
                <th className="px-3 py-2.5 text-right font-medium">Orders</th>
                <th className="px-3 py-2.5 font-medium">Sales</th>
                <th className="px-3 py-2.5 text-right font-medium">Avg order</th>
                <th className="px-3 py-2.5 text-right font-medium text-tone-green">Delivered</th>
                <th className="px-3 py-2.5 text-right font-medium text-tone-red">Returned</th>
                <th className="px-3 py-2.5 text-right font-medium">Cancelled</th>
                <th className="px-3 py-2.5 text-right font-medium">Delivery %</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r: any, i: number) => (
                <tr key={r.month} className={cn(i === 0 && "bg-tone-violet-bg/30")}>
                  <td className="whitespace-nowrap px-4 py-2.5 font-medium">{fmtMonth(r.month)}{i === 0 && <span className="ml-1.5 text-[10px] font-semibold uppercase text-tone-violet">so far</span>}</td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{r.orders}</td>
                  <td className="min-w-48 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-tone-blue" style={{ width: `${(r.sales / max) * 100}%` }} /></div>
                      <span className="w-24 text-right tabular-nums">{taka(r.sales)}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.orders ? taka(Math.round(r.sales / r.orders)) : "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-tone-green">{r.delivered}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-tone-red">{r.returned}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.cancelled}</td>
                  <td className="px-3 py-2.5 text-right">
                    {r.deliveryRate === null ? <span className="text-muted-foreground">—</span> : (
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", r.deliveryRate >= 80 ? "bg-tone-green-bg text-tone-green" : r.deliveryRate >= 65 ? "bg-tone-amber-bg text-tone-amber" : "bg-tone-red-bg text-tone-red")}>{r.deliveryRate}%</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-2 text-[11px] text-muted-foreground">Orders and sales exclude cancelled. Delivery % = delivered ÷ (delivered + returned).</p>
        </div>
      )}
    </section>
  )
}
