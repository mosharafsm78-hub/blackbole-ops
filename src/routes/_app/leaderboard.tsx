import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Trophy, Medal, Award as AwardIcon, Zap } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Guard, useCan, useMe } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill, Stat } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { dateTime, errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/leaderboard")({
  component: () => (
    <Guard perm="dashboard.view">
      <Leaderboard />
    </Guard>
  ),
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
                r.staffName === me.name && "bg-tone-blue-bg",
              )}
            >
              <div className="flex items-center gap-2">
                <Rank i={i} />
                <span className="text-sm font-medium">{r.staffName}{r.staffName === me.name && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}</span>
              </div>
              <span className={cn("text-sm font-semibold tabular-nums", r.points < 0 && "text-tone-red")}>{r.points}</span>
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
function RuleBook() {
  const rules = useQuery(api.kpi.listRules, {})
  const [open, setOpen] = useState(false)
  if (rules === undefined) return null
  const byTeam = new Map<string, typeof rules>()
  for (const r of rules) byTeam.set(r.team, [...(byTeam.get(r.team) ?? []), r])

  return (
    <div className="rounded-lg border bg-card p-4">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-2 text-left">
        <div className="flex items-center gap-2">
          <Zap className="size-4 text-tone-amber" />
          <h2 className="font-semibold">How to earn points</h2>
        </div>
        <span className="text-xs text-muted-foreground">{open ? "Hide" : "Show"} the full rule book</span>
      </button>
      <p className="mt-1 text-xs text-muted-foreground">
        Every rule is fully automatic — there's no "award points" button anywhere. The moment the real thing
        happens (a call, a delivery, a clean shipment, a flag), the points post themselves.
      </p>
      {open && (
        <div className="mt-3 space-y-4">
          {[...byTeam.entries()].map(([team, rows]) => (
            <div key={team}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{team}</h3>
              <div className="mt-1.5 space-y-1">
                {rows.map((r) => (
                  <div key={r.key} className="flex items-center justify-between gap-3 text-sm">
                    <span className={cn(!r.active && "text-muted-foreground line-through")}>{r.label}</span>
                    <span className={cn("shrink-0 font-semibold tabular-nums", r.points < 0 ? "text-tone-red" : "text-tone-green")}>
                      {r.points > 0 ? "+" : ""}{r.points}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function monthKeyNow() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

/** Month-end prize pool: lock in the top 3 of the monthly bank, then mark each paid once the real cash has
 *  actually gone out by hand — the app only ever records that it happened, never moves the money itself. */
function PayoutsPanel() {
  const [month, setMonth] = useState(monthKeyNow())
  const payouts = useQuery(api.kpi.listPayouts, { month })
  const finalize = useMutation(api.kpi.finalizeMonth)
  const markPaid = useMutation(api.kpi.markPayoutPaid)
  const [prizes, setPrizes] = useState(["1800", "800", "400"])
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
        Locks in the top finishers of that month's bank. Re-running it after a late award is fine — it never
        touches a rank already marked paid.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        {["1st", "2nd", "3rd"].map((label, i) => (
          <div key={label} className="space-y-1">
            <Label className="text-xs">{label} (৳)</Label>
            <Input className="w-24" type="number" value={prizes[i]} onChange={(e) => setPrizes((p) => p.map((v, j) => (j === i ? e.target.value : v)))} />
          </div>
        ))}
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

function Leaderboard() {
  const can = useCan()
  const canManage = can("team.manage")
  const board = useQuery(api.kpi.leaderboard, {})

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Leaderboard" sub="Weekly sprint, resets every Monday — points bank into the monthly total that decides the prize pool." />

      <MyPoints />

      <RuleBook />

      {board === undefined ? <Loading /> : board === null ? (
        <Empty title="Sign in to see the board">The leaderboard is only visible to signed-in staff.</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Board title="This week" rows={board.weekly} hint={`ends ${dateTime(board.weekEnd)}`} />
          <Board title={`This month (${board.month})`} rows={board.monthly} hint="banked total" />
        </div>
      )}

      <RecentFeed />

      {canManage && <PayoutsPanel />}
    </div>
  )
}
