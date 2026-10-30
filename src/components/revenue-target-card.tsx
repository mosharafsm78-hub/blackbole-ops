import { Link } from "@tanstack/react-router"
import { Check, Flag, X } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { daysInMonth } from "@/convex/targetMath"
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
          <p className="mt-0.5 text-xs text-muted-foreground">Delivered orders only · today's target re-balances from what's still missing</p>
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
