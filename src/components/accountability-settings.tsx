import { useEffect, useState } from "react"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { TEAM_STYLE } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loading } from "@/components/bits"
import { errMsg } from "@/lib/format"

// The teams accountability flags can route to today — Fulfillment/Marketing from ACCOUNTABILITY_ROUTING
// (convex/rules.ts), Customer Care so free-form questions can be raised against it too even though no return
// reason auto-routes there yet.
const TEAMS = ["Fulfillment", "Marketing", "Customer Care"]

type Owner = { name: string; email: string }

/** Settings → Accountability: who, by name, actually owns each team's flags (so one lands on a real person,
 *  not just "Fulfillment" in the abstract) — and who the operations head is, who gets pinged if a flag sits
 *  open past the 2-day SLA (convex/accountability.ts's daily checkOverdue). */
export function AccountabilitySettings() {
  const data = useQuery(api.accountability.ownersSettings)
  const save = useMutation(api.accountability.saveOwners)
  const [byTeam, setByTeam] = useState<Record<string, Owner> | null>(null)
  const [opsHead, setOpsHead] = useState<Owner>({ name: "", email: "" })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (data && !byTeam) {
      setByTeam(data.byTeam ?? {})
      if (data.opsHead) setOpsHead(data.opsHead)
    }
  }, [data, byTeam])

  if (!data || !byTeam) return <Loading />

  const setOwner = (team: string, field: keyof Owner, val: string) =>
    setByTeam((b) => ({ ...(b ?? {}), [team]: { ...(b?.[team] ?? { name: "", email: "" }), [field]: val } }))

  const doSave = async () => {
    setBusy(true)
    try {
      const clean: Record<string, Owner> = {}
      for (const t of TEAMS) {
        const o = byTeam[t]
        if (o?.name?.trim() && o?.email?.trim()) clean[t] = { name: o.name.trim(), email: o.email.trim() }
      }
      await save({ byTeam: clean, opsHead: opsHead.name.trim() && opsHead.email.trim() ? { name: opsHead.name.trim(), email: opsHead.email.trim() } : undefined })
      toast.success("Saved")
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-5">
        <h2 className="font-semibold">Accountability — who owns what</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A flag (an at-fault return reason, or a question someone raises) is routed to a team — this is who, by
          name, it actually lands on. They get an email the moment it's raised, and another every day it stays
          open past 2 days. Leave a team blank and its flags just show the team name, with no one personally
          pinged.
        </p>
        <div className="mt-4 space-y-4">
          {TEAMS.map((t) => (
            <div key={t} className="flex flex-wrap items-end gap-3 rounded-md border p-3">
              <span className={`shrink-0 rounded px-2 py-1 text-xs font-bold uppercase tracking-wide ${TEAM_STYLE[t] ?? "bg-muted text-muted-foreground"}`}>{t}</span>
              <div className="min-w-[160px] flex-1 space-y-1">
                <Label className="text-xs">Owner's name</Label>
                <Input value={byTeam[t]?.name ?? ""} onChange={(e) => setOwner(t, "name", e.target.value)} placeholder="e.g. Rafi" />
              </div>
              <div className="min-w-[200px] flex-1 space-y-1">
                <Label className="text-xs">Owner's email</Label>
                <Input value={byTeam[t]?.email ?? ""} onChange={(e) => setOwner(t, "email", e.target.value)} placeholder="name@example.com" />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h2 className="font-semibold">Operations head — escalation</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          If a flag is still open 2+ days after it was raised, this person gets pinged too (on top of the
          assignee being nudged again), every day it stays open, so nothing quietly sits unanswered.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[160px] flex-1 space-y-1">
            <Label className="text-xs">Name</Label>
            <Input value={opsHead.name} onChange={(e) => setOpsHead((o) => ({ ...o, name: e.target.value }))} placeholder="e.g. Saju" />
          </div>
          <div className="min-w-[200px] flex-1 space-y-1">
            <Label className="text-xs">Email</Label>
            <Input value={opsHead.email} onChange={(e) => setOpsHead((o) => ({ ...o, email: e.target.value }))} placeholder="name@example.com" />
          </div>
        </div>
      </section>

      <Button disabled={busy} onClick={() => void doSave()}>Save</Button>
    </div>
  )
}
