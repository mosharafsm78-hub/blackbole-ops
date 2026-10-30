import { useEffect, useState } from "react"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { dhakaMonth } from "@/convex/targetMath"
import { Loading } from "@/components/bits"
import { monthLabel } from "@/components/revenue-target-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { errMsg, taka } from "@/lib/format"

const nextMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`
}

/** Settings → KPI: the company-wide monthly revenue target (this month and next). Revenue means delivered
 *  orders only; the Dashboard splits the month into daily targets on its own. */
export function RevenueTargetSettings() {
  const thisMonth = dhakaMonth(Date.now())
  return (
    <section className="rounded-lg border bg-card p-5" data-testid="revenue-target-settings">
      <h2 className="font-semibold">Monthly revenue target</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        One target for the whole company. Only delivered orders count, on the day they're delivered. The Dashboard
        turns it into a daily target that re-balances every day — a slow day raises tomorrow's target, a big day
        lowers it. Set 0 to remove a target.
      </p>
      <div className="mt-4 space-y-3">
        <TargetRow month={thisMonth} />
        <TargetRow month={nextMonth(thisMonth)} />
      </div>
    </section>
  )
}

function TargetRow({ month }: { month: string }) {
  const current = useQuery(api.targets.getTarget, { month })
  const save = useMutation(api.targets.setMonthlyTarget)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)

  // Keep the box in step with what's saved (first load, or a change made elsewhere).
  useEffect(() => { if (current !== undefined) setDraft(current ? String(current.amount) : "") }, [current])

  if (current === undefined) return <Loading />

  const amount = draft.trim() === "" ? 0 : Number(draft)
  const invalid = !Number.isFinite(amount) || amount < 0
  const unchanged = Math.round(amount) === (current?.amount ?? 0)

  const commit = async () => {
    setBusy(true)
    try {
      await save({ month, amount })
      toast.success(amount === 0 ? "Target removed" : `Target for ${monthLabel(month)} set to ${taka(amount)}`)
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{monthLabel(month)}</p>
        <p className="text-xs text-muted-foreground">{current ? `${taka(current.amount)} · set by ${current.setByName}` : "No target set"}</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">৳</span>
        <Input
          type="number" inputMode="numeric" min={0} step={1000} placeholder="e.g. 3000000" value={draft}
          onChange={(e) => setDraft(e.target.value)} className="w-40 text-right tabular-nums" disabled={busy} aria-label={`Revenue target for ${monthLabel(month)}`}
        />
        <Button size="sm" disabled={busy || invalid || unchanged} onClick={() => void commit()}>Save</Button>
      </div>
    </div>
  )
}
