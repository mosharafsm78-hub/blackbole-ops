import { Link } from "@tanstack/react-router"
import { AlertTriangle, Check, ChevronRight, Flag, X } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { addDays } from "@/convex/targetMath"
import { familyOf, GROUP_SHARE, type Group, type ProductRow } from "@/convex/targetPlan"
import type { MarketingView, TargetProgress } from "@/convex/targets"
import { useCan } from "@/components/app-shell"
import { Pill } from "@/components/bits"
import { usePolledAction } from "@/lib/use-polled-action"
import { taka } from "@/lib/format"
import { cn } from "@/lib/utils"

/** "November 2026" from "2026-11". */
export const monthLabel = (month: string) => {
  const [y, m] = month.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
}

const dayLabel = (day: string) => `${Number(day.slice(8, 10))} ${new Date(`${day}T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`

export const useTargetProgress = () => usePolledAction(api.targets.progress, {}, 60000) // live: refreshes every minute

/** Dashboard: a glance only — today's target, the month, and a way in to the full Target page. */
export function RevenueTargetCard() {
  const can = useCan()
  const data = useTargetProgress()
  if (!data) return null

  if (!data.target || !data.plan) {
    if (!can("team.manage")) return null
    return (
      <section className="rounded-xl border border-dashed bg-card p-4" data-testid="revenue-target-empty">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm"><Flag className="size-4 text-muted-foreground" /><span className="font-semibold">No revenue target for {monthLabel(data.month)}</span></div>
          <Link to="/settings" className="text-xs font-medium text-tone-blue hover:underline">Set one in Settings → KPI →</Link>
        </div>
      </section>
    )
  }

  const p = data.plan
  const t = p.focus
  const beaten = p.remaining === 0
  const onPace = p.pct >= (p.days.length / p.daysInMonth) * 100
  return (
    <section className="rounded-xl border bg-card p-4" data-testid="revenue-target-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Flag className="size-4 text-tone-blue" />Target — {dayLabel(p.start)} to {dayLabel(p.end)}</h2>
        <Link to="/target" className="inline-flex items-center gap-0.5 text-xs font-medium text-tone-blue hover:underline">Full plan <ChevronRight className="size-3.5" /></Link>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Fig label={t?.upcoming ? `Target for ${dayLabel(t.day)}` : "Today's target"} value={t ? taka(t.target) : "—"} sub={t ? (t.toGo > 0 ? `${taka(t.delivered)} done · ${taka(t.toGo)} to go` : `${taka(t.delivered)} delivered ✓`) : "period is over"} tone={t && t.toGo === 0 ? "green" : undefined} />
        <Fig label="This month" value={taka(p.delivered)} sub={`of ${taka(p.target)} · ${beaten ? "reached" : `${p.pct}%`}`} />
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.min(100, p.pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn("h-full rounded-full", beaten || onPace ? "bg-tone-green" : "bg-tone-amber")} style={{ width: `${Math.min(100, p.pct)}%` }} />
      </div>
    </section>
  )
}

/** The Target page: daily and monthly target on top, then profit, marketing budget, the product plan and the day log. */
export function TargetPlanView({ data }: { data: TargetProgress }) {
  const p = data.plan!
  const t = p.focus
  const beaten = p.remaining === 0
  const onPace = p.pct >= (p.days.length / p.daysInMonth) * 100
  return (
    <div className="space-y-4" data-testid="target-page">
      <p className="text-xs text-muted-foreground">
        {dayLabel(p.start)} → {dayLabel(p.end)} · {p.daysInMonth} days · delivered orders only · a missed day moves to the days after it
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border bg-card p-4" data-testid="target-daily">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t?.upcoming ? `Daily target — starts ${dayLabel(t.day)}` : `Today's target — ${t ? dayLabel(t.day) : ""}`}</h2>
            {t && !t.upcoming && <Pill tone={t.toGo === 0 ? "green" : "amber"}>{t.toGo === 0 ? "Done for today" : `${taka(t.toGo)} to go`}</Pill>}
          </div>
          <div className="mt-2 text-3xl font-bold tabular-nums">{t ? taka(t.target) : "—"}</div>
          <p className="text-xs text-muted-foreground">
            {t ? (t.upcoming ? "Each day's share of the month." : `${taka(t.delivered)} delivered so far today.`) : "The period is over."}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Fig label="Each day after today" value={p.perDayFromTomorrow > 0 ? taka(p.perDayFromTomorrow) : "—"} sub={p.perDayFromTomorrow > 0 ? "to still land the month" : beaten ? "nothing more needed" : "no days left"} />
            <Fig label="Days left" value={String(p.daysLeft)} sub="including today" />
          </div>
        </section>
        <section className="rounded-xl border bg-card p-4" data-testid="target-monthly">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Monthly target — {monthLabel(p.month)}{data.auto && <span className="ml-2 rounded bg-tone-blue/15 px-1.5 py-0.5 text-[11px] font-semibold text-tone-blue">set automatically</span>}</h2>
            <Pill tone={beaten || onPace ? "green" : "amber"}>{beaten ? "Target reached" : `${p.pct}%`}</Pill>
          </div>
          <div className="mt-2 text-3xl font-bold tabular-nums">{taka(p.target)}</div>
          <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.min(100, p.pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className={cn("h-full rounded-full", beaten || onPace ? "bg-tone-green" : "bg-tone-amber")} style={{ width: `${Math.min(100, p.pct)}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Fig label="Delivered so far" value={taka(p.delivered)} sub="delivered orders only" />
            <Fig label="Still to deliver" value={taka(p.remaining)} sub={p.finished ? "period is over" : `${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left`} />
          </div>
        </section>
      </div>

      <StockNotes data={data} />
      <DailyMarketing data={data} />
      <SellList data={data} />
      <Models data={data} />
      {data.marketing && <MarketingStrip m={data.marketing} />}
      {data.profit && <ProfitStrip p={data.profit} target={p.target} />}
      <Schedule p={p} />
      <ProductPlan data={data} />
    </div>
  )
}

/** The daily sheet: what to sell today, in pairs — the focus products carry it, the rest is a one-line total. */
function SellList({ data }: { data: TargetProgress }) {
  const rows = data.products
  const p = data.plan!
  if (!rows || rows.length === 0) return null
  const day = p.focus ? dayLabel(p.focus.day) : ""
  const focus = rows.filter((r) => r.group === "focus" && (r.todayTarget ?? 0) > 0).sort((a, b) => (b.todayTarget ?? 0) - (a.todayTarget ?? 0))
  const rest = (g: Group) => rows.filter((r) => r.group === g)
  const line = (g: Group, title: string) => {
    const list = rest(g)
    if (list.length === 0) return null
    const target = sum(list, (r) => r.todayTarget ?? 0)
    return <li key={g}><b className="text-foreground">{title}:</b> {target} pairs across {list.length} products (sold {sum(list, (r) => r.todaySold)})</li>
  }
  const total = sum(rows, (r) => r.todayTarget ?? 0)
  const budget = data.daily?.adBudget ?? 0
  const worthAll = sum(rows, (r) => (r.todayTarget ?? 0) * r.price) // the budget is split by each product's share of the day's value
  return (
    <section className="rounded-xl border bg-card p-4" data-testid="target-sell-list">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Sell today ({day}) — pairs per product</h2>
        <span className="text-xs text-muted-foreground">{total} pairs in all · focus products carry it</span>
      </div>
      <div className="mt-2 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[460px] text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr><th className="px-3 py-1.5 text-left font-medium">Product</th><th className="px-3 py-1.5 text-right font-medium">Sell</th><th className="px-3 py-1.5 text-right font-medium">Sold</th><th className="px-3 py-1.5 text-right font-medium">To go</th><th className="px-3 py-1.5 text-right font-medium">Worth</th>{budget > 0 && <th className="px-3 py-1.5 text-right font-medium">Ad budget</th>}</tr>
          </thead>
          <tbody>
            {focus.map((r) => (
              <tr key={r.key} className="border-t">
                <td className="px-3 py-1.5 font-medium">{r.name}</td>
                <td className="px-3 py-1.5 text-right text-base font-bold tabular-nums">{r.todayTarget}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.todaySold}</td>
                <td className={cn("px-3 py-1.5 text-right tabular-nums", r.toGo === 0 ? "text-tone-green" : "font-semibold")}>{r.toGo === 0 ? "✓" : r.toGo}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{taka((r.todayTarget ?? 0) * r.price)}</td>
                {budget > 0 && <td className="px-3 py-1.5 text-right tabular-nums">{taka(budget * (((r.todayTarget ?? 0) * r.price) / Math.max(1, worthAll)))}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">{line("other", "Others")}{line("dead", "Dead stock")}</ul>
    </section>
  )
}

/** Real stock vs test stock: a nudge to count what is not yet counted, and the products being tested without stock. */
function StockNotes({ data }: { data: TargetProgress }) {
  const can = useCan()
  const c = data.stockCheck
  const left = c ? c.lines - c.counted : 0
  if (left <= 0 && data.tests.length === 0) return null
  return (
    <div className="space-y-3" data-testid="target-stock-notes">
      {c && left > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-tone-amber/40 bg-tone-amber-bg/40 p-3 text-xs">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-tone-amber" />
          <span>
            <b>{left} of {c.lines} stock lines haven't been counted yet.</b> Until they are, some test (fake) stock may still be inside this plan as if it were in hand.{" "}
            {can("inventory.adjust") && <Link to="/stock-check" className="font-medium text-tone-blue hover:underline">Count them in Stock check →</Link>}
          </span>
        </div>
      )}
      {data.tests.length > 0 && (
        <section className="rounded-xl border bg-card p-4" data-testid="target-tests">
          <h2 className="text-sm font-semibold">Marketing tests — stock not in hand</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Test pairs are advertised and can be ordered, but aren't planned: there are no real pairs to deliver. A product that gets {5}+ orders in a week has proven demand — buy it from the supplier in Purchases, and it joins the plan by itself once received.</p>
          <div className="mt-2 overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr><th className="px-3 py-1.5 text-left font-medium">Product</th><th className="px-3 py-1.5 text-right font-medium">Test pairs</th><th className="px-3 py-1.5 text-right font-medium">In hand</th><th className="px-3 py-1.5 text-right font-medium">Ordered (7 days)</th><th className="px-3 py-1.5 text-right font-medium">Decision</th></tr>
              </thead>
              <tbody>
                {data.tests.slice(0, 20).map((t) => (
                  <tr key={t.key} className="border-t">
                    <td className="px-3 py-1.5 font-medium">{t.name}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-tone-amber">{t.fake}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{t.real}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{t.ordered7}</td>
                    <td className="px-3 py-1.5 text-right">{t.proven ? <span className="font-semibold text-tone-green">{t.buy > 0 ? `Buy ${t.buy} pairs` : "Enough in hand"}</span> : <span className="text-muted-foreground">Keep testing</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

/** Today's marketing, as three plain instructions: how many orders to book, how much to spend, what to push. */
function DailyMarketing({ data }: { data: TargetProgress }) {
  const d = data.daily
  if (!d) return null
  const m = data.measured
  const over = d.adLeft < 0
  const ret = Math.round(d.returnRate * 100)
  const push = (data.products ?? []).filter((r) => r.group === "focus" && (r.todayTarget ?? 0) > 0).sort((a, b) => (b.todayTarget ?? 0) - (a.todayTarget ?? 0)).slice(0, 3)
  return (
    <section className={cn("rounded-xl border bg-card p-4", d.adsCantPay && "border-tone-amber/40")} data-testid="target-daily-marketing">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Marketing — what to do today</h2>
        <Pill tone={over ? "red" : "green"}>{over ? `${taka(-d.adLeft)} over today's budget` : `${taka(d.spentToday)} spent · ${taka(d.adLeft)} left`}</Pill>
      </div>
      <ol className="mt-3 space-y-3 text-sm">
        <li className="flex gap-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-tone-blue/15 text-xs font-bold text-tone-blue">1</span>
          <div>
            <div>Bring in <b className="text-lg tabular-nums">{d.ordersToBook}</b> orders today</div>
            <div className="text-xs text-muted-foreground">Only delivered orders count toward the target, and about {ret}% of orders come back. So {d.ordersToDeliver} must be delivered, and booking {d.ordersToBook} gets you there.</div>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-tone-blue/15 text-xs font-bold text-tone-blue">2</span>
          <div>
            <div>Spend about <b className="text-lg tabular-nums">{taka(d.adBudget)}</b> on ads — never more than <b className="tabular-nums">{taka(d.adMax)}</b></div>
            <div className="text-xs text-muted-foreground">Above {taka(d.adMax)} every extra order loses money, after shoe cost, courier, packaging, fees and returns.</div>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-tone-blue/15 text-xs font-bold text-tone-blue">3</span>
          <div>
            <div>Push these products first</div>
            <div className="text-xs text-muted-foreground">{push.length > 0 ? push.map((r) => `${r.name} (${r.todayTarget} pairs)`).join(" · ") : "See the list below."} Full list with the ad budget for each product is just below.</div>
          </div>
        </li>
      </ol>
      {d.adsCantPay && <p className="mt-3 flex items-start gap-1.5 text-xs text-tone-amber"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />Ads currently return too little to pay for this target in full, so the budget is held at the safe limit. Improve the ads or the product mix before spending more.</p>}
      {m && <p className="mt-2 text-xs text-muted-foreground">Return rate, courier cost and payment fee are measured from your last {m.sample} orders ({m.returnPct}% returned).</p>}
    </section>
  )
}

/** Stock against plan, by model (colours together) — so a big pile like the Veyron loafers is plain to see. */
function Models({ data }: { data: TargetProgress }) {
  const rows = data.products
  if (!rows) return null
  const byFamily = new Map<string, ProductRow[]>()
  for (const r of rows) byFamily.set(familyOf(r.name), [...(byFamily.get(familyOf(r.name)) ?? []), r])
  const list = [...byFamily.entries()]
    .map(([name, rs]) => ({ name, colours: rs.length, stock: rs.some((r) => r.stockUnits !== null) ? sum(rs, (r) => r.stockUnits ?? 0) : null, plan: sum(rs, (r) => r.monthUnits), sold: sum(rs, (r) => r.sold), today: sum(rs, (r) => r.todayTarget ?? 0), todaySold: sum(rs, (r) => r.todaySold) }))
    .filter((f) => f.stock !== null || f.plan > 0)
    .sort((a, b) => (b.stock ?? 0) - (a.stock ?? 0))
    .slice(0, 12)
  if (list.length === 0) return null
  return (
    <section className="rounded-xl border bg-card p-4" data-testid="target-models">
      <h2 className="text-sm font-semibold">By model — stock against the plan</h2>
      <div className="mt-2 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr><th className="px-3 py-1.5 text-left font-medium">Model</th><th className="px-3 py-1.5 text-right font-medium">In stock</th><th className="px-3 py-1.5 text-right font-medium">Month plan</th><th className="px-3 py-1.5 text-right font-medium">Sold</th><th className="px-3 py-1.5 text-right font-medium">Today</th></tr>
          </thead>
          <tbody>
            {list.map((f) => (
              <tr key={f.name} className="border-t">
                <td className="px-3 py-1.5"><div className="font-medium">{f.name}</div>{f.colours > 1 && <div className="text-[11px] text-muted-foreground">{f.colours} colours</div>}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{f.stock === null ? "pre-order" : f.stock}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{f.plan}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{f.sold}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{f.todaySold}/{f.today}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const weekday = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleString("en-US", { weekday: "short", timeZone: "UTC" })

/** Every day of the period: past days with what was delivered, today highlighted, coming days with their share. */
function Schedule({ p }: { p: NonNullable<TargetProgress["plan"]> }) {
  const rows: { day: string; target: number; delivered: number | null; hit: boolean; isToday: boolean }[] = p.days.map((d) => ({ day: d.day, target: d.target, delivered: d.delivered, hit: d.hit, isToday: d.isToday }))
  const lastShown = p.days.length > 0 ? p.days[p.days.length - 1].day : addDays(p.start, -1)
  // Coming days: what each must deliver to still land the month (from tomorrow), or the even share before the start.
  const future = p.started ? p.perDayFromTomorrow : Math.ceil(p.target / p.daysInMonth)
  for (let day = addDays(lastShown, 1); day <= p.end; day = addDays(day, 1)) rows.push({ day, target: future, delivered: null, hit: false, isToday: false })
  return (
    <details open className="rounded-xl border bg-card p-4" data-testid="target-schedule">
      <summary className="cursor-pointer select-none text-sm font-semibold">Day by day — every day of the month</summary>
      <div className="mt-2 max-h-[420px] overflow-auto rounded-lg border">
        <table className="w-full min-w-[360px] text-sm">
          <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
            <tr><th className="px-3 py-1.5 text-left font-medium">Day</th><th className="px-3 py-1.5 text-right font-medium">Target</th><th className="px-3 py-1.5 text-right font-medium">Delivered</th><th className="w-10 px-3 py-1.5" /></tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.day} className={cn("border-t", d.isToday && "bg-tone-blue-bg/40", d.delivered === null && "text-muted-foreground")}>
                <td className="px-3 py-1.5">{weekday(d.day)} {dayLabel(d.day)}{d.isToday && <span className="ml-1.5 text-[11px] font-semibold text-tone-blue">today</span>}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{taka(d.target)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium">{d.delivered === null ? "" : taka(d.delivered)}</td>
                <td className="px-3 py-1.5 text-center">
                  {d.delivered === null ? null : d.hit ? <Check className="inline size-4 text-tone-green" aria-label="Hit" /> : d.isToday ? null : <X className="inline size-4 text-tone-red" aria-label="Missed" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

function Fig({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "green" }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-xl font-bold tabular-nums", tone === "green" && "text-tone-green")}>{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  )
}

const status = {
  on_track: { tone: "green", text: "On track" },
  overspending: { tone: "red", text: "Spending ahead of results — tighten or fix ads" },
  underspending: { tone: "amber", text: "Behind on revenue and on spend — more budget needed" },
  no_history: { tone: "amber", text: "Not enough ad history yet" },
} as const

/** Marketing's number: what the target needs in ad spend, and what has been spent. Only sent to people with ads access. */
function MarketingStrip({ m }: { m: MarketingView }) {
  if (m.state === "not_configured") return null
  if (m.state === "error") return <p className="mt-3 text-xs text-muted-foreground">Ad spend couldn't be loaded from Meta just now.</p>
  const x = m.plan
  const s = status[x.status]
  const pct = x.budget ? Math.min(100, Math.round((x.spentMtd / x.budget) * 100)) : 0
  return (
    <div className="mt-4 rounded-lg border p-3" data-testid="target-marketing">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Marketing budget</h3>
        <Pill tone={s.tone}>{s.text}</Pill>
      </div>
      {x.budget === null ? (
        <p className="mt-1 text-xs text-muted-foreground">The budget is worked out from the last 30 days of ad spend and revenue. Spent this month: {taka(x.spentMtd)}.</p>
      ) : (
        <>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-tone-blue" style={{ width: `${pct}%` }} /></div>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Fig label="Budget for the month" value={taka(x.budget)} sub={`${x.mer}× return on ad spend (30 days)`} />
            <Fig label="Spent so far" value={taka(x.spentMtd)} sub={`${taka(x.expectedToDate ?? 0)} expected by today`} />
            <Fig label="Left in budget" value={taka(Math.max(0, x.remaining ?? 0))} sub={(x.remaining ?? 0) < 0 ? `${taka(-(x.remaining ?? 0))} over budget` : "of the month's budget"} />
            <Fig label="Needed for the rest" value={taka(x.neededForRest ?? 0)} sub="to deliver what's still missing" />
          </div>
        </>
      )}
    </div>
  )
}

/** Will this target make money? Shoe cost, the ad budget and the fixed costs, against the target. Managers only. */
function ProfitStrip({ p, target }: { p: NonNullable<TargetProgress["profit"]>; target: number }) {
  const makes = p.profitAtTarget >= 0
  return (
    <div className={cn("mt-4 rounded-lg border p-3", !makes && "border-tone-red/30 bg-tone-red-bg/30")} data-testid="target-profit">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Profit</h3>
        <Pill tone={makes ? "green" : "red"}>{makes ? `Target makes ${taka(p.profitAtTarget)}` : `Target loses ${taka(-p.profitAtTarget)}`}</Pill>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fig label="Break-even revenue" value={p.breakEven === null ? "never" : taka(p.breakEven)} sub={p.breakEven === null ? "ads eat the whole margin" : `${taka(p.fixed)} fixed costs a month`} />
        <Fig label="Profit at target" value={taka(p.profitAtTarget)} sub={`on ${taka(target)} delivered`} tone={makes ? "green" : undefined} />
        <Fig label="Profit so far" value={taka(p.profitMtd)} sub="after costs for the days gone" tone={p.profitMtd >= 0 ? "green" : undefined} />
        <Fig label="Each ৳100 earns" value={`৳${(p.contribution * 100).toFixed(1)}`} sub="after shoes, delivery, packaging, fees and ads" />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Out of every ৳100 delivered: ৳{(p.grossMargin * 100).toFixed(0)} is shoe margin · ৳{(p.orderCostRate * 100).toFixed(1)} delivery + packaging (average order {taka(p.aov)}, with {Math.round(p.returnRate * 100)}% of shipped orders returning) · ৳{(p.payFeeRate * 100).toFixed(1)} payment fee · ৳{(p.adRate * 100).toFixed(1)} ads. Shoes that come back are assumed resellable.
      </p>
      {!makes && p.breakEven !== null && <p className="mt-2 text-xs">Raise the target to at least <b>{taka(p.breakEven)}</b> or cut ad cost per order — at this target the month loses money.</p>}
    </div>
  )
}

const GROUPS: { key: Group; title: string; note: string }[] = [
  { key: "focus", title: "Focus products", note: "Good stock and a full size run — this is where the daily push goes." },
  { key: "other", title: "Others", note: "Sizes are fine but stock is thin (under 10 pairs). Sell when it comes up." },
  { key: "dead", title: "Dead stock", note: "Broken size run or no sales lately. A small share, to clear it." },
]

const sum = (rows: ProductRow[], f: (r: ProductRow) => number) => rows.reduce((s, r) => s + f(r), 0)

/** Every product's share of the month in pairs, in three groups: the daily pressure sits on the focus products. */
function ProductPlan({ data }: { data: TargetProgress }) {
  const rows = data.products
  if (!rows) return null
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">No product sales or stock to base a product plan on yet.</p>
  const gap = data.productInfo?.gap ?? 0
  const short = data.productInfo?.unitsShort ?? 0
  return (
    <section className="rounded-xl border bg-card p-4" data-testid="target-products">
      <h2 className="text-sm font-semibold">What to sell — pairs per product</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">Split by what sold best in the last {data.productInfo?.windowDays} days, capped by stock. Re-planned every week.</p>
      {gap > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-tone-red/30 bg-tone-red-bg/40 p-2.5 text-xs" data-testid="target-stock-gap">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-tone-red" />
          <span><b>Stock can't carry this target.</b> About {taka(gap)} of it has no stock behind it — restock the best sellers or lower the target.</span>
        </div>
      )}
      {gap === 0 && short > 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-tone-amber"><AlertTriangle className="size-3.5" />{short} pair{short === 1 ? "" : "s"} of the plan are more than current stock — restock soon.</p>
      )}
      <div className="mt-3 space-y-3">
        {GROUPS.map((g) => {
          const list = rows.filter((r) => r.group === g.key)
          if (list.length === 0) return null
          const todayT = list.every((r) => r.todayTarget === null) ? null : sum(list, (r) => r.todayTarget ?? 0)
          const head = (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div>
                <div className="text-sm font-semibold">{g.title} <span className="font-normal text-muted-foreground">· {list.length} · ~{Math.round(GROUP_SHARE[g.key] * 100)}% of the target</span></div>
                <div className="text-xs text-muted-foreground">{g.note}</div>
              </div>
              <div className="text-xs tabular-nums text-muted-foreground">
                {sum(list, (r) => r.monthUnits)} pairs · {sum(list, (r) => r.sold)} sold{todayT !== null && <> · today <b className="text-foreground">{sum(list, (r) => r.todaySold)}/{todayT}</b></>}
              </div>
            </div>
          )
          return g.key === "focus" ? (
            <div key={g.key}>{head}<Table rows={list} /></div>
          ) : (
            <details key={g.key} className="rounded-lg border p-3">
              <summary className="cursor-pointer select-none list-none">{head}</summary>
              <Table rows={list} />
            </details>
          )
        })}
      </div>
    </section>
  )
}

function Table({ rows }: { rows: ProductRow[] }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[620px] text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Product</th>
            <th className="px-3 py-1.5 text-right font-medium">Month plan</th>
            <th className="px-3 py-1.5 text-right font-medium">Sold</th>
            <th className="px-3 py-1.5 text-right font-medium">Today</th>
            <th className="px-3 py-1.5 text-right font-medium">Each day after</th>
            <th className="px-3 py-1.5 text-right font-medium">In stock</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t">
              <td className="px-3 py-1.5">
                <div className="font-medium">{r.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {r.left === 0 ? "plan done ✓" : `${r.left} to go`}
                  {r.sizes && r.sizes.total >= 3 && <span className={cn("ml-1.5", r.sizes.inStock / r.sizes.total < 0.6 && "font-semibold text-tone-red")}>{r.sizes.inStock}/{r.sizes.total} sizes</span>}
                  {r.overstock && <span className="ml-1.5 font-semibold text-tone-amber">piling up — push in ads</span>}
                  {r.stockShort > 0 && <span className="ml-1.5 font-semibold text-tone-red">short by {r.stockShort}</span>}
                </div>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.monthUnits}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.sold}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {r.todayTarget === null ? "—" : (
                  <span className={cn(r.toGo === 0 && r.todayTarget > 0 && "text-tone-green")}>
                    {r.todaySold}/{r.todayTarget}{r.toGo === 0 && r.todayTarget > 0 ? " ✓" : ""}
                  </span>
                )}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.perDayAfterToday || "—"}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                {r.stockUnits === null ? "pre-order" : r.stockUnits}{r.coverDays !== null && <span className="block text-[11px]">{r.coverDays}d cover</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
