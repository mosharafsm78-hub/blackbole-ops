import { Link } from "@tanstack/react-router"
import { AlertTriangle, Check, Flag, X } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { daysInMonth } from "@/convex/targetMath"
import { useCan } from "@/components/app-shell"
import { Pill } from "@/components/bits"
import type { MarketingView, TargetProgress } from "@/convex/targets"
import { usePolledAction } from "@/lib/use-polled-action"
import { taka } from "@/lib/format"
import { cn } from "@/lib/utils"

/** "November 2026" from "2026-11". */
export const monthLabel = (month: string) => {
  const [y, m] = month.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
}

const dayLabel = (day: string) => `${Number(day.slice(8, 10))} ${new Date(`${day}T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`

/** Dashboard card: this month's company revenue target — delivered so far, today's re-balanced target, and the
 *  day-by-day record. Read-only; the target itself is set in Settings → KPI. */
export function RevenueTargetCard() {
  const can = useCan()
  const data = usePolledAction(api.targets.progress, {}, 5 * 60000)
  if (!data) return null

  if (!data.target || !data.plan) {
    // Nothing to show to people who can't set one; a nudge for those who can.
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
  const t = p.today
  const bar = Math.min(100, p.pct)
  const beaten = p.remaining === 0
  const elapsed = p.days.length

  return (
    <section className="rounded-xl border bg-card p-4" data-testid="revenue-target-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Flag className="size-4 text-tone-blue" />Revenue target — {monthLabel(p.month)}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {!p.started ? "Preview — starts " + dayLabel(`${p.month}-01`) + " · " : ""}Delivered orders only · worked out from sales and stock; a missed day moves to the days after it
          </p>
        </div>
        <Pill tone={beaten ? "green" : p.pct >= (elapsed / daysInMonth(p.month)) * 100 ? "green" : "amber"}>
          {beaten ? "Target reached" : `${p.pct}% of ${taka(p.target)}`}
        </Pill>
      </div>

      <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={bar} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn("h-full rounded-full transition-all", beaten ? "bg-tone-green" : "bg-tone-blue")} style={{ width: `${bar}%` }} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fig label="Delivered so far" value={taka(p.delivered)} sub={`of ${taka(p.target)}`} />
        <Fig label="Still to deliver" value={taka(p.remaining)} sub={p.finished ? "month is over" : `${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left incl. today`} />
        {t ? (
          <Fig
            label="Today's target"
            value={taka(t.target)}
            sub={t.toGo > 0 ? `${taka(t.delivered)} done · ${taka(t.toGo)} to go` : `${taka(t.delivered)} delivered today ✓`}
            tone={t.toGo > 0 ? undefined : "green"}
          />
        ) : <Fig label="Today's target" value="—" sub={p.finished ? "month is over" : "month hasn't started"} />}
        <Fig label="Each day after today" value={p.perDayFromTomorrow > 0 ? taka(p.perDayFromTomorrow) : "—"} sub={p.perDayFromTomorrow > 0 ? "needed to land the month" : beaten ? "nothing more needed" : "no days left"} />
      </div>

      {data.profit && <ProfitStrip p={data.profit} target={p.target} />}
      {data.marketing && <MarketingStrip m={data.marketing} />}
      <ProductPlan data={data} />

      {p.days.length > 0 && (
        <details className="group mt-3">
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">Day by day</summary>
          <div className="mt-2 overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[320px] text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr><th className="px-3 py-1.5 text-left font-medium">Day</th><th className="px-3 py-1.5 text-right font-medium">Target</th><th className="px-3 py-1.5 text-right font-medium">Delivered</th><th className="w-10 px-3 py-1.5" /></tr>
              </thead>
              <tbody>
                {[...p.days].reverse().map((d) => (
                  <tr key={d.day} className={cn("border-t", d.isToday && "bg-tone-blue-bg/40")}>
                    <td className="px-3 py-1.5">{dayLabel(d.day)}{d.isToday && <span className="ml-1.5 text-[11px] font-semibold text-tone-blue">today</span>}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{taka(d.target)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-medium">{taka(d.delivered)}</td>
                    <td className="px-3 py-1.5 text-center">
                      {d.hit ? <Check className="inline size-4 text-tone-green" aria-label="Hit" /> : d.isToday ? null : <X className="inline size-4 text-tone-red" aria-label="Missed" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
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

/** Every product's share of the month in pairs, today's catch-up-adjusted target, and the stock behind it. */
function ProductPlan({ data }: { data: TargetProgress }) {
  const rows = data.products
  if (!rows) return null
  if (rows.length === 0) return <p className="mt-4 text-xs text-muted-foreground">No product sales in the last {data.productInfo?.windowDays ?? 60} days to base a product plan on yet.</p>
  const gap = data.productInfo?.gap ?? 0
  const short = data.productInfo?.unitsShort ?? 0
  return (
    <div className="mt-4" data-testid="target-products">
      <h3 className="text-sm font-semibold">What to sell — pairs per product</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">Split by what sold best in the last {data.productInfo?.windowDays} days, capped by what is in stock. Re-planned every week.</p>
      {gap > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-tone-red/30 bg-tone-red-bg/40 p-2.5 text-xs" data-testid="target-stock-gap">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-tone-red" />
          <span><b>Stock can't carry this target.</b> About {taka(gap)} of it has no stock behind it — restock the best sellers or lower the target.</span>
        </div>
      )}
      {gap === 0 && short > 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-tone-amber"><AlertTriangle className="size-3.5" />{short} pair{short === 1 ? "" : "s"} of the plan are more than current stock — restock soon.</p>
      )}
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
        <Fig label="Each ৳100 earns" value={`৳${Math.round(p.contribution * 100)}`} sub={`${Math.round(p.grossMargin * 100)}% margin − ${Math.round(p.adRate * 100)}% ads`} />
      </div>
      {!makes && p.breakEven !== null && <p className="mt-2 text-xs">Raise the target to at least <b>{taka(p.breakEven)}</b> or cut ad cost per order — at this target the month loses money.</p>}
    </div>
  )
}
