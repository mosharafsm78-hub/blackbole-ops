import { useState } from "react"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Loading, Pill, TEAM_STYLE } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Settings → KPI: the full rule book behind the Leaderboard — every point value and whether each rule is
 *  live, editable without a redeploy. "Auto" rules fire themselves off real activity (a cleared advance, a
 *  recovered cart…); everything else only ever lands through a manual award, because the system has no
 *  reliable way yet to tell who personally earned or caused it. */
export function KpiRulesSettings() {
  const rules = useQuery(api.kpi.listRules, {})
  const save = useMutation(api.kpi.saveRule)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, number>>({})

  if (rules === undefined) return <Loading />

  const pointsFor = (key: string, fallback: number) => (draft[key] !== undefined ? draft[key] : fallback)

  const commitPoints = async (key: string, points: number, active: boolean) => {
    setBusyKey(key)
    try {
      await save({ key, points, active })
    } catch (e) { toast.error(errMsg(e)) } finally { setBusyKey(null) }
  }

  const toggleActive = async (key: string, points: number, active: boolean) => {
    setBusyKey(key)
    try {
      await save({ key, points, active })
      toast.success(active ? "Rule turned on" : "Rule turned off")
    } catch (e) { toast.error(errMsg(e)) } finally { setBusyKey(null) }
  }

  const byTeam = new Map<string, typeof rules>()
  for (const r of rules) byTeam.set(r.team, [...(byTeam.get(r.team) ?? []), r])

  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-5">
        <h2 className="font-semibold">KPI — leaderboard point rules</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Edit any point value or switch a rule off — it takes effect immediately on the Leaderboard, no deploy
          needed. "Auto" rules fire themselves from order/accountability activity; the rest are only ever
          awarded by hand from the Leaderboard page, since there's no reliable way yet to attribute them to one
          person automatically.
        </p>
      </section>
      {[...byTeam.entries()].map(([team, teamRules]) => (
        <section key={team} className="rounded-lg border bg-card p-5">
          <h3 className={cn("inline-flex rounded px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide", TEAM_STYLE[team] ?? "bg-muted text-muted-foreground")}>{team}</h3>
          <div className="mt-3 space-y-2">
            {teamRules!.map((r) => (
              <div key={r.key} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{r.label}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    {r.auto ? <Pill tone="green">Auto</Pill> : <Pill tone="gray">Manual award</Pill>}
                    {!r.active && <Pill tone="red">Off</Pill>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    value={pointsFor(r.key, r.points)}
                    onChange={(e) => setDraft((d) => ({ ...d, [r.key]: Number(e.target.value) }))}
                    onBlur={() => {
                      const v = pointsFor(r.key, r.points)
                      if (v !== r.points) void commitPoints(r.key, v, r.active)
                    }}
                    className="w-20 text-right tabular-nums"
                    disabled={busyKey === r.key}
                  />
                  <span className="text-xs text-muted-foreground">pts</span>
                  <Switch checked={r.active} disabled={busyKey === r.key} onCheckedChange={(v) => void toggleActive(r.key, pointsFor(r.key, r.points), v)} />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
