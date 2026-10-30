import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Trophy, Medal, Award as AwardIcon } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Guard, useCan, useMe } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill, Stat } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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

/** A Super Admin crediting or docking someone by hand for anything the automatic rules can't see — packer
 *  speed observed on the floor, a mis-ship once the right person is known, a marketing call. */
function AwardPointsDialog() {
  const staff = useQuery(api.team.listStaff, {})
  const award = useMutation(api.kpi.manualAward)
  const [open, setOpen] = useState(false)
  const [staffName, setStaffName] = useState("")
  const [points, setPoints] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  const active = (staff ?? []).filter((s) => s.active)

  const submit = async () => {
    const n = Number(points)
    if (!staffName) { toast.error("Pick who this is for."); return }
    if (!Number.isFinite(n) || n === 0) { toast.error("Enter a non-zero points value."); return }
    if (!reason.trim()) { toast.error("Write a reason."); return }
    setBusy(true)
    try {
      await award({ staffName, points: n, reason: reason.trim() })
      toast.success("Awarded")
      setOpen(false); setStaffName(""); setPoints(""); setReason("")
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Award points</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Award points</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Staff member</Label>
              <Select value={staffName} onValueChange={setStaffName}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Pick who this is for" /></SelectTrigger>
                <SelectContent>
                  {active.map((s) => <SelectItem key={s._id} value={s.name}>{s.name} — {s.roleName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Points (negative to dock)</Label>
              <Input type="number" value={points} onChange={(e) => setPoints(e.target.value)} placeholder="e.g. 20 or -50" />
            </div>
            <div className="space-y-1.5">
              <Label>Reason</Label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Packed 48 pairs/hour on the morning shift — well above baseline" />
            </div>
          </div>
          <DialogFooter>
            <Button disabled={busy} onClick={() => void submit()}>Award</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
      <PageHeader title="Leaderboard" sub="Weekly sprint, resets every Monday — points bank into the monthly total that decides the prize pool.">
        {canManage && <AwardPointsDialog />}
      </PageHeader>

      <MyPoints />

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
