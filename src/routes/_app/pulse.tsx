import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Trophy, Medal, Award as AwardIcon, Zap, Crown, HeartPulse, ChevronDown } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { useCan, useMe } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill, Stat } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { dateTime, errMsg, type Tone } from "@/lib/format"
import { cn } from "@/lib/utils"

// No permission gate here on purpose — the whole point of this page is that every signed-in staff member can
// see how the business is doing and where they and everyone else stand, not just roles that happen to hold
// dashboard.view.
export const Route = createFileRoute("/_app/pulse")({
  component: () => <Pulse />,
})

const MEDAL = [
  { icon: Trophy, cls: "text-tone-amber" },
  { icon: Medal, cls: "text-tone-gray" },
  { icon: AwardIcon, cls: "text-tone-orange" },
]

function Rank({ i }: { i: number }) {
  const m = MEDAL[i]
  if (!m) return <span className="w-5 text-center text-sm font-semibold text-muted-foreground">{i + 1}</span>
  const Icon = m.icon
  return <Icon className={cn("size-5", m.cls)} />
}

function Board({ title, rows, hint }: { title: string; rows: { staffName: string; points: number }[]; hint: string }) {
  const me = useMe()
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No points yet this window.</p>
      ) : (
        <div className="mt-3 space-y-1">
          {rows.map((r, i) => (
            <div
              key={r.staffName}
              className={cn(
                "flex items-center justify-between gap-2 rounded-md px-2 py-1.5",
                i === 0 && "bg-gradient-to-r from-tone-amber-bg to-transparent",
                r.staffName === me.name && "ring-1 ring-tone-blue",
                r.staffName === me.name && i !== 0 && "bg-tone-blue-bg",
              )}
            >
              <div className="flex items-center gap-2">
                <Rank i={i} />
                <span className="text-sm font-medium">
                  {r.staffName}
                  {i === 0 && rows.length > 1 && <Crown className="ml-1 inline size-3.5 text-tone-amber" />}
                  {r.staffName === me.name && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}
                </span>
              </div>
              <span className={cn("text-sm font-semibold tabular-nums", r.points < 0 && "text-tone-red")}>{r.points}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const HEALTH_TONE = (score: number): Tone => (score >= 80 ? "green" : score >= 60 ? "amber" : "red")

/** The business health score, front and center — out of 100, with the handful of pillars behind it, the same
 *  idea as Amazon's seller "Account Health" rating: one number for "how are we doing right now", built from
 *  real signals the dashboard and the automatic accountability flags already track, never a self-reported
 *  claim. A pillar that gets dragged down caps the overall number even if the rest look fine. */
function BusinessHealthCard() {
  const health = useQuery(api.accountability.businessHealth, {})
  const [open, setOpen] = useState(false)
  if (health === undefined) return <Loading />
  if (health === null) return null
  const tone = HEALTH_TONE(health.score)

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <HeartPulse className={cn("size-5", `text-tone-${tone}`)} />
          <h2 className="font-semibold">Business health</h2>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"} the breakdown
          <ChevronDown className={cn("ml-1 size-3.5 transition-transform", open && "rotate-180")} />
        </Button>
      </div>

      <div className="mt-3 flex items-center gap-4">
        <div className={cn("flex size-20 shrink-0 items-center justify-center rounded-full border-4 text-2xl font-bold tabular-nums", `border-tone-${tone} text-tone-${tone}`)}>
          {health.score}%
        </div>
        <div>
          <Pill tone={tone}>{health.status}</Pill>
          <p className="mt-1 text-sm text-muted-foreground">
            {health.capReason ? `Held down by: ${health.capReason}.` : "Weighted across delivery, order flow, returns, sales and accountability — see the breakdown for each."}
          </p>
        </div>
      </div>

      {open && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {health.pillars.map((pl) => (
            <div key={pl.key} className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{pl.label}</span>
                <span className={cn("text-sm font-semibold tabular-nums", `text-tone-${HEALTH_TONE(pl.score)}`)}>{pl.score}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{pl.note}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MyPoints() {
  const mine = useQuery(api.kpi.myPoints, {})
  if (mine === undefined) return <Loading />
  if (mine === null) return null
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
      <Stat label="Your points this week" value={mine.week} tone={mine.week < 0 ? "red" : "green"} />
      <Stat label="Your points this month" value={mine.month} tone={mine.month < 0 ? "red" : "green"} />
    </div>
  )
}

function RecentFeed() {
  const feed = useQuery(api.kpi.recentFeed, { limit: 20 })
  if (feed === undefined) return <Loading />
  if (feed.length === 0) return <Empty title="No activity yet">Points will show up here the moment the first one is earned.</Empty>
  return (
    <div className="rounded-lg border bg-card p-4">
      <h2 className="font-semibold">Recent activity</h2>
      <div className="mt-3 space-y-2">
        {feed.map((e) => (
          <div key={e._id} className="flex items-start justify-between gap-3 border-b pb-2 text-sm last:border-0 last:pb-0">
            <div className="min-w-0">
              <p><span className="font-medium">{e.staffName}</span> — {e.label}</p>
              <p className="text-xs text-muted-foreground">{dateTime(e.at)}{e.byName ? ` · by ${e.byName}` : ""}</p>
            </div>
            <span className={cn("shrink-0 text-sm font-semibold tabular-nums", e.points < 0 ? "text-tone-red" : "text-tone-green")}>
              {e.points > 0 ? "+" : ""}{e.points}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Every way to earn or lose points, grouped by department — visible to every signed-in staff member, not
 *  just leads. There is no "award points" button anywhere in this app anymore: every row below fires on its
 *  own, off a real event the system already records, the moment that event happens. This is the one place
 *  that promise is made visible, so nobody has to take it on faith. */
// ops.flag_raised and ops.overdue_flag are deliberately ONE shared rule, not four separate ones — they fire
// against whichever department actually owns the mistake or the overdue flag, resolved at the moment it
// happens (see Settings → Accountability), not hardcoded per team. DEFAULT_RULES tags them "Operations" because
// that's where they're configured, but every front-line department is really on the hook for them. Shown once
// under Operations for configuring, and copied into each front-line section below so it's not invisible there.
const SHARED_PENALTY_KEYS = ["ops.flag_raised", "ops.overdue_flag"]
const FRONT_LINE_TEAMS = ["Customer Care", "Fulfillment", "Marketing"]

function RuleBook() {
  const rules = useQuery(api.kpi.listRules, {})
  const [open, setOpen] = useState(false)
  if (rules === undefined) return null
  const byTeam = new Map<string, typeof rules>()
  for (const r of rules) byTeam.set(r.team, [...(byTeam.get(r.team) ?? []), r])
  const sharedPenalties = rules.filter((r) => SHARED_PENALTY_KEYS.includes(r.key))
  for (const team of FRONT_LINE_TEAMS) if (byTeam.has(team)) byTeam.set(team, [...byTeam.get(team)!, ...sharedPenalties])

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-tone-amber" />
          <h2 className="font-semibold">How to earn points</h2>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"} the full rule book
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Every rule is fully automatic — there's no "award points" button anywhere. The moment the real thing
        happens (a call, a delivery, a clean shipment, a flag), the points post themselves.
      </p>
      {open && (
        <div className="mt-3 space-y-4">
          {[...byTeam.entries()].map(([team, rows]) => {
            const sharedCount = FRONT_LINE_TEAMS.includes(team) ? sharedPenalties.length : 0
            const ownRows = sharedCount ? rows.slice(0, -sharedCount) : rows
            const sharedRows = sharedCount ? rows.slice(-sharedCount) : []
            return (
              <div key={team}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{team}</h3>
                <div className="mt-1.5 space-y-1">
                  {ownRows.map((r) => (
                    <div key={r.key} className="flex items-center justify-between gap-3 text-sm">
                      <span className={cn(!r.active && "text-muted-foreground line-through")}>{r.label}</span>
                      <span className={cn("shrink-0 font-semibold tabular-nums", r.points < 0 ? "text-tone-red" : "text-tone-green")}>
                        {r.points > 0 ? "+" : ""}{r.points}
                      </span>
                    </div>
                  ))}
                  {sharedRows.length > 0 && (
                    <>
                      <p className="pt-1 text-[11px] text-muted-foreground">Also on the hook for (shared across every department):</p>
                      {sharedRows.map((r) => (
                        <div key={`${team}-${r.key}`} className="flex items-center justify-between gap-3 text-sm">
                          <span className={cn(!r.active && "text-muted-foreground line-through")}>{r.label}</span>
                          <span className={cn("shrink-0 font-semibold tabular-nums", r.points < 0 ? "text-tone-red" : "text-tone-green")}>
                            {r.points > 0 ? "+" : ""}{r.points}
                          </span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function monthKeyNow() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

/** Month-end prize pool. The 1st-place payout now happens on its own — see the auto-finalize cron in
 *  crons.ts — so nobody has to click anything for the normal case. This panel is only for a lead who needs to
 *  check what went out, mark the actual cash as paid once it's handed over, or re-run a month by hand (a late
 *  award that should have counted, a different prize split for one month). Re-running is always safe: it
 *  never touches a rank already marked paid. */
function PayoutsPanel() {
  const [month, setMonth] = useState(monthKeyNow())
  const payouts = useQuery(api.kpi.listPayouts, { month })
  const finalize = useMutation(api.kpi.finalizeMonth)
  const markPaid = useMutation(api.kpi.markPayoutPaid)
  const [prizes, setPrizes] = useState(["3000"])
  const [busy, setBusy] = useState(false)

  const doFinalize = async () => {
    setBusy(true)
    try {
      const res = await finalize({ month, prizes: prizes.map((p) => Number(p) || 0) })
      toast.success(`Finalized — ${res.created} payout${res.created === 1 ? "" : "s"} created`)
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }

  const pay = async (id: string, staffName: string) => {
    try {
      await markPaid({ id: id as any, note: `Marked paid` })
      toast.success(`${staffName} marked paid`)
    } catch (e) { toast.error(errMsg(e)) }
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Monthly prize pool</h2>
        <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-40" />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Pays out on its own on the 1st of the month for the month that just ended — this is only for checking
        what went out, marking it paid, or re-running a month by hand.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        {prizes.map((amount, i) => (
          <div key={i} className="space-y-1">
            <Label className="text-xs">{i === 0 ? "1st" : i === 1 ? "2nd" : i === 2 ? "3rd" : `${i + 1}th`} (৳)</Label>
            <Input className="w-24" type="number" value={amount} onChange={(e) => setPrizes((p) => p.map((v, j) => (j === i ? e.target.value : v)))} />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => setPrizes((p) => [...p, "0"])}>+ Add place</Button>
        <Button size="sm" disabled={busy} onClick={() => void doFinalize()}>Finalize {month}</Button>
      </div>

      {payouts === undefined ? <Loading /> : payouts.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No payouts finalized for {month} yet.</p>
      ) : (
        <div className="mt-4 space-y-2">
          {[...payouts].sort((a, b) => a.rank - b.rank).map((p) => (
            <div key={p._id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">#{p.rank} — {p.staffName}</p>
                <p className="text-xs text-muted-foreground">{p.points} pts · ৳{p.amount}</p>
              </div>
              {p.status === "paid" ? (
                <Pill tone="green">Paid{p.paidAt ? ` · ${dateTime(p.paidAt)}` : ""}</Pill>
              ) : (
                <Button size="sm" variant="outline" onClick={() => void pay(p._id, p.staffName)}>Mark paid</Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Pulse() {
  const can = useCan()
  const canManage = can("team.manage")
  const board = useQuery(api.kpi.leaderboard, {})

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Pulse"
        sub="How the business is doing right now, and how the team is doing earning it. Sprint runs Saturday through Thursday (Friday's the weekly off), banking into the monthly total — top of the month wins the cash prize, paid out automatically."
      />

      <BusinessHealthCard />

      {board === undefined ? <Loading /> : board === null ? (
        <Empty title="Sign in to see Pulse">This page is only visible to signed-in staff.</Empty>
      ) : (
        <>
          <MyPoints />

          <div className="grid gap-4 sm:grid-cols-2">
            <Board title="This week" rows={board.weekly} hint={`ends ${dateTime(board.weekEnd)}`} />
            <Board title={`This month (${board.month})`} rows={board.monthly} hint="banked total" />
          </div>

          <RuleBook />

          <RecentFeed />

          {canManage && <PayoutsPanel />}
        </>
      )}
    </div>
  )
}
