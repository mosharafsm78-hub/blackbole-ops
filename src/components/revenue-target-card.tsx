import { Link } from "@tanstack/react-router"
import { Check, Flag, X } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { addDays, type MonthPlan } from "@/convex/targetMath"
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

export const dayLabel = (day: string) => `${Number(day.slice(8, 10))} ${new Date(`${day}T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`

export const useTargetProgress = () => usePolledAction(api.targets.progress, {}, 60000) // live: refreshes every minute, or instantly via the returned refetch

/** Dashboard: a glance only — today's target, the month, and a way in to the full Target page. */
export function RevenueTargetCard() {
  const can = useCan()
  const [data] = useTargetProgress()
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
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Flag className="size-4 text-tone-blue" />Target (Cx — delivered) — {dayLabel(p.start)} to {dayLabel(p.end)}</h2>
        <Link to="/target/cx" className="text-xs font-medium text-tone-blue hover:underline">Full plan →</Link>
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

/** Customer Care's own Target page: daily and monthly delivered-revenue target, what Marketing is booking (so CX
 *  knows what's coming), profit, the day-by-day log, and which products still need delivering. Deliberately
 *  carries none of Marketing's own job — what to sell, ad budget, restock, stock levels, suggested pricing. Those
 *  live on Marketing's own /target page; copying them here would blur who is actually responsible for what. */
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
            <h2 className="text-sm font-semibold">Monthly target (Cx — delivered) — {monthLabel(p.month)}{data.auto && <span className="ml-2 rounded bg-tone-blue/15 px-1.5 py-0.5 text-[11px] font-semibold text-tone-blue">set automatically</span>}</h2>
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

      {data.gross && <GrossSaleStrip gross={data.gross} />}
      {data.profit && <ProfitStrip p={data.profit} target={p.target} />}
      <Schedule p={p} />
      <DeliveredByProduct products={data.products} />
    </div>
  )
}

/** What's been delivered so far this month, by product, against what Marketing's bookings call for — and what's
 *  still owed. No "what to sell", no stock levels, no pricing: delivering what's already been ordered is the
 *  whole job here, not deciding what gets pushed or restocked (that's Marketing's plan, on its own page). */
function DeliveredByProduct({ products }: { products: ProductRow[] | null }) {
  const rows = products
  if (!rows || rows.length === 0) return null
  const list = [...rows].filter((r) => r.monthUnits > 0 || r.sold > 0).sort((a, b) => b.left - a.left)
  if (list.length === 0) return null
  return (
    <section className="rounded-xl border bg-card p-4" data-testid="target-delivered-by-product">
      <h2 className="text-sm font-semibold">Delivered so far, by product</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">What Marketing's bookings call for this month, what's been delivered, and what's still owed.</p>
      <div className="mt-2 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[420px] text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr><th className="px-3 py-1.5 text-left font-medium">Product</th><th className="px-3 py-1.5 text-right font-medium">Delivered</th><th className="px-3 py-1.5 text-right font-medium">Called for</th><th className="px-3 py-1.5 text-right font-medium">Still owed</th></tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.key} className="border-t">
                <td className="px-3 py-1.5 font-medium">{r.name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.sold}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.monthUnits}</td>
                <td className={cn("px-3 py-1.5 text-right tabular-nums", r.left === 0 ? "text-tone-green" : "font-semibold")}>{r.left === 0 ? "✓" : r.left}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** Marketing's own KPI: the full value of orders once placed, this month — regardless of whether they're later
 *  delivered, cancelled or returned. Deliberately styled apart from the delivered-revenue cards above so the two
 *  audiences (finance/ops vs. marketing) don't mix them up. */
export function GrossSaleStrip({ gross }: { gross: NonNullable<TargetProgress["gross"]> }) {
  const pct = gross.target > 0 ? Math.round((gross.mtd / gross.target) * 100) : 0
  const beaten = gross.mtd >= gross.target
  return (
    <section className="rounded-xl border border-tone-violet/30 bg-tone-violet-bg/20 p-4" data-testid="target-gross-sale">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Gross sale (Marketing)</h2>
        <Pill tone={beaten ? "green" : "violet"}>{beaten ? "Target reached" : `${pct}%`}</Pill>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">Every order counted the moment it's placed, whatever happens to it after — Marketing brings the order in, confirming and delivering it isn't theirs to answer for. Separate from the delivered-revenue target below.</p>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.min(100, pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn("h-full rounded-full", beaten ? "bg-tone-green" : "bg-tone-violet")} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Fig label="Gross sale so far" value={taka(gross.mtd)} sub={`of ${taka(gross.target)} this month`} tone={beaten ? "green" : undefined} />
        <Fig label="Still needed" value={taka(Math.max(0, gross.target - gross.mtd))} sub={beaten ? "target reached" : "to reach the gross-sale target"} />
      </div>
    </section>
  )
}

/** The daily sheet: what to sell today, in pairs — the focus products carry it, the rest is a one-line total.
 *  `budget` (today's ad spend) is optional — pass 0 to drop the ad-budget column entirely, as the Marketing
 *  page's own plan does (it has no ad-spend math of its own). */
export function SellList({ products, day, budget }: { products: ProductRow[] | null; day: string; budget: number }) {
  const rows = products
  if (!rows || rows.length === 0) return null
  const focus = rows.filter((r) => r.group === "focus" && (r.todayTarget ?? 0) > 0).sort((a, b) => (b.todayTarget ?? 0) - (a.todayTarget ?? 0))
  const rest = (g: Group) => rows.filter((r) => r.group === g)
  const line = (g: Group, title: string) => {
    const list = rest(g)
    if (list.length === 0) return null
    const target = sum(list, (r) => r.todayTarget ?? 0)
    return <li key={g}><b className="text-foreground">{title}:</b> {target} pairs across {list.length} products (sold {sum(list, (r) => r.todaySold)})</li>
  }
  const total = sum(rows, (r) => r.todayTarget ?? 0)
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

/** Stock against plan, by model (colours together) — so a big pile like the Veyron loafers is plain to see. */
export function Models({ products }: { products: ProductRow[] | null }) {
  const rows = products
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

export const weekday = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleString("en-US", { weekday: "short", timeZone: "UTC" })

/** Every day of the period: past days with what was delivered, today highlighted, coming days with their share.
 *  Generic over MonthPlan — used for both the Cx delivered plan and the Marketing gross plan, which reinterprets
 *  "delivered" as "placed". */
export function Schedule({ p }: { p: MonthPlan }) {
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

export function Fig({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "green" }) {
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
export function MarketingStrip({ m }: { m: MarketingView }) {
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
        Out of every ৳100 delivered: ৳{(p.grossRate * 100).toFixed(1)} is kept after the shoes' own cost
        {Math.abs(p.grossRate - p.grossMargin) >= 0.005 && (
          <> (the shoes themselves run a {(p.grossMargin * 100).toFixed(0)}% margin — discounts and the delivery-fee math {p.grossRate > p.grossMargin ? "push" : "pull"} that to this)</>
        )}
        {" "}· ৳{(p.orderCostRate * 100).toFixed(1)} delivery + packaging (average order {taka(p.aov)}, with {Math.round(p.returnRate * 100)}% of shipped orders returning) · ৳{(p.payFeeRate * 100).toFixed(1)} payment fee · ৳{(p.adRate * 100).toFixed(1)} ads — leaving the ৳{(p.contribution * 100).toFixed(1)} above. Shoes that come back are assumed resellable.
      </p>
      {!makes && p.breakEven !== null && <p className="mt-2 text-xs">Raise the target to at least <b>{taka(p.breakEven)}</b> or cut ad cost per order — at this target the month loses money.</p>}
    </div>
  )
}

export const GROUPS: { key: Group; title: string; note: string }[] = [
  { key: "focus", title: "Focus products", note: "Good stock and a full size run — this is where the daily push goes." },
  { key: "other", title: "Others", note: "Sizes are fine but stock is thin (under 10 pairs). Sell when it comes up." },
  { key: "dead", title: "Dead stock", note: "Broken size run or no sales lately. A small share, to clear it." },
]

export const sum = (rows: ProductRow[], f: (r: ProductRow) => number) => rows.reduce((s, r) => s + f(r), 0)

