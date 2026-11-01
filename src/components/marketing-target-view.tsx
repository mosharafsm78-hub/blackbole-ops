import { AlertTriangle } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { GROUP_SHARE } from "@/convex/targetPlan"
import type { MarketingProgress } from "@/convex/targets"
import { Pill } from "@/components/bits"
import { RestockSuggestions } from "@/components/restock-suggestions"
import {
  dayLabel, Fig, GROUPS, Models, Schedule, SellList, StockNotes, Table, monthLabel, sum,
} from "@/components/revenue-target-card"
import { usePolledAction } from "@/lib/use-polled-action"
import { taka } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Marketing's own page: live, refreshes every minute or instantly via the returned refetch. */
export const useMarketingProgress = () => usePolledAction(api.targets.marketingProgress, {}, 60000)

/** The whole Target page, now solely for Marketing: the ৳18,00,000-style gross-sale target — counted from the
 *  moment an order is placed, not approved or delivered — daily pacing toward it, and which products (how many
 *  pairs of each) need to sell to reach it, against current stock. Deliberately carries none of the Cx/delivery
 *  team's numbers (ad budget, profit, break-even, suggested pricing) — those depend on delivery outcomes and will
 *  live on a separate Customer Care page once that's built. */
export function MarketingTargetView({ data, refetch }: { data: MarketingProgress; refetch: () => void }) {
  const p = data.plan
  const t = p.focus
  const beaten = p.remaining === 0
  const onPace = p.pct >= (p.days.length / p.daysInMonth) * 100
  return (
    <div className="space-y-4" data-testid="marketing-target-page">
      <p className="text-xs text-muted-foreground">
        {dayLabel(p.start)} → {dayLabel(p.end)} · {p.daysInMonth} days · every order counted the moment it's placed, whatever happens to it after
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border bg-card p-4" data-testid="marketing-target-daily">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t?.upcoming ? `Daily target — starts ${dayLabel(t.day)}` : `Today's target — ${t ? dayLabel(t.day) : ""}`}</h2>
            {t && !t.upcoming && <Pill tone={t.toGo === 0 ? "green" : "amber"}>{t.toGo === 0 ? "Done for today" : `${taka(t.toGo)} to go`}</Pill>}
          </div>
          <div className="mt-2 text-3xl font-bold tabular-nums">{t ? taka(t.target) : "—"}</div>
          <p className="text-xs text-muted-foreground">
            {t ? (t.upcoming ? "Each day's share of the month." : `${taka(t.delivered)} placed so far today.`) : "The period is over."}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Fig label="Each day after today" value={p.perDayFromTomorrow > 0 ? taka(p.perDayFromTomorrow) : "—"} sub={p.perDayFromTomorrow > 0 ? "to still land the month" : beaten ? "nothing more needed" : "no days left"} />
            <Fig label="Days left" value={String(p.daysLeft)} sub="including today" />
          </div>
        </section>
        <section className="rounded-xl border border-tone-violet/30 bg-tone-violet-bg/20 p-4" data-testid="marketing-target-monthly">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Gross sale target — {monthLabel(p.month)}</h2>
            <Pill tone={beaten || onPace ? "green" : "violet"}>{beaten ? "Target reached" : `${p.pct}%`}</Pill>
          </div>
          <div className="mt-2 text-3xl font-bold tabular-nums">{taka(p.target)}</div>
          <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.min(100, p.pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className={cn("h-full rounded-full", beaten || onPace ? "bg-tone-green" : "bg-tone-violet")} style={{ width: `${Math.min(100, p.pct)}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Fig label="Placed so far" value={taka(p.delivered)} sub="every order's full total, once placed" />
            <Fig label="Still needed" value={taka(p.remaining)} sub={p.finished ? "period is over" : `${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left`} />
          </div>
        </section>
      </div>

      <StockNotes stockCheck={data.stockCheck} tests={data.tests} />
      <RestockSuggestions restock={data.restock} restockDismissedCount={data.restockDismissedCount} refetch={refetch} />
      <SellList products={data.products} day={t ? dayLabel(t.day) : ""} budget={0} />
      <Models products={data.products} />
      <Schedule p={p} />
      <MarketingProductPlan data={data} />
    </div>
  )
}

/** Every product's share of the gross target, in pairs, in three groups — same mechanics as the Cx product plan,
 *  minus the suggested-price column (that math is tied to profit/ad-spend, which this page doesn't carry). */
function MarketingProductPlan({ data }: { data: MarketingProgress }) {
  const rows = data.products
  if (!rows) return null
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">No orders or stock to base a product plan on yet.</p>
  const gap = data.productInfo?.gap ?? 0
  const short = data.productInfo?.unitsShort ?? 0
  return (
    <section className="rounded-xl border bg-card p-4" data-testid="marketing-target-products">
      <h2 className="text-sm font-semibold">Which products — pairs needed to reach the gross target</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">Split by what sold best in the last {data.productInfo?.windowDays} days, capped by stock. Re-planned every week.</p>
      {gap > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-tone-red/30 bg-tone-red-bg/40 p-2.5 text-xs" data-testid="marketing-stock-gap">
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
            <div key={g.key}>{head}<Table rows={list} reqOrderRate={null} ratio={1} /></div>
          ) : (
            <details key={g.key} className="rounded-lg border p-3">
              <summary className="cursor-pointer select-none list-none">{head}</summary>
              <Table rows={list} reqOrderRate={null} ratio={1} />
            </details>
          )
        })}
      </div>
    </section>
  )
}
