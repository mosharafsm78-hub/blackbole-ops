import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dateTime, errMsg } from "@/lib/format"

/** The fields the modal edits, normalised so a legacy record with no note/assignee behaves exactly like a fresh
 *  one: every input is a controlled string, never undefined, so nothing can flip uncontrolled mid-edit. */
function initialState(flag: any) {
  return {
    team: (flag?.team ?? "") as string,
    assignee: (flag?.assignee ?? "") as string,
    reason: (flag?.reason ?? "") as string,
    note: (flag?.note ?? "") as string,
  }
}

/**
 * Super Admin "Edit / Re-route".
 *
 * Corrects a misassigned case (a delivery error filed under MKT instead of OPS) or a typo in its title/note
 * WITHOUT closing and re-creating it — so the case keeps one unbroken history.
 *
 * Two things this deliberately does:
 *  - Reseeds its state every time it opens, from the flag as it is NOW. Re-opening after a save therefore shows
 *    the saved values, never a stale draft from the previous open.
 *  - Treats "nothing changed" as a disabled Save, mirroring the mutation's own no-op guard, so an accidental
 *    double-click can't pad the audit trail or mail anyone.
 */
export function RerouteDialog({ flag, open, onOpenChange }: { flag: any; open: boolean; onOpenChange: (o: boolean) => void }) {
  const reroute = useMutation(api.accountability.rerouteOpsFlag)
  const choices = useQuery(api.accountability.assigneeChoices, open ? {} : "skip")
  const [form, setForm] = useState(() => initialState(flag))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) setForm(initialState(flag))
  }, [open, flag])

  const set = (k: keyof ReturnType<typeof initialState>) => (v: string) => setForm((f) => ({ ...f, [k]: v }))

  const start = useMemo(() => initialState(flag), [flag])
  const changed = (["team", "assignee", "reason", "note"] as const).filter((k) => (form[k] ?? "") !== (start[k] ?? ""))
  const rerouted = changed.includes("team") || changed.includes("assignee")
  const canSave = changed.length > 0 && form.team.trim() !== "" && form.reason.trim() !== "" && !busy

  const submit = async () => {
    if (!canSave) return
    setBusy(true)
    try {
      const res = await reroute({
        id: flag._id,
        team: form.team.trim(),
        assignee: form.assignee.trim() || undefined,
        reason: form.reason.trim(),
        note: form.note.trim() || undefined,
      })
      if (res?.noop) toast.success("Nothing changed")
      else if (res?.skippedEmailBecause) toast.warning(`Saved — but not emailed: ${res.skippedEmailBecause}`)
      else if (res?.emailed) toast.success("Saved — the new lead has been emailed")
      else toast.success("Saved")
      onOpenChange(false)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const teams: string[] = choices?.teams ?? ["Customer Care", "Fulfillment", "Marketing", "Development"]
  const people: { name: string; email: string }[] = choices?.people ?? []
  const teamLead = choices?.byTeam?.[form.team] ?? null
  // Whoever currently holds the department is the natural default, so re-routing normally needs one click.
  const suggestion = teamLead?.name ?? ""

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent data-testid="reroute-dialog">
        <DialogHeader><DialogTitle>Edit / re-route case</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Fix a misassigned or misspelled case without closing it. Changing the department or the assignee emails
            the new lead once — the old lead is never re-emailed.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="rr-team">Department</Label>
              <Select value={form.team} onValueChange={set("team")}>
                <SelectTrigger id="rr-team" className="w-full" data-testid="reroute-team"><SelectValue placeholder="Pick a department" /></SelectTrigger>
                <SelectContent>
                  {teams.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rr-assignee">Lead assignee</Label>
              <Input
                id="rr-assignee"
                data-testid="reroute-assignee"
                list="rr-people"
                value={form.assignee}
                onChange={(e) => set("assignee")(e.target.value)}
                placeholder={suggestion || "Who owns this now?"}
              />
              <datalist id="rr-people">{people.map((p) => <option key={p.email} value={p.name} />)}</datalist>
              {suggestion && form.assignee.trim() !== suggestion && (
                <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => set("assignee")(suggestion)}>
                  Use the {form.team} lead — {suggestion}
                </button>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="rr-title">Issue title / reason</Label>
            <Input id="rr-title" data-testid="reroute-title" value={form.reason} onChange={(e) => set("reason")(e.target.value)} placeholder="e.g. Wrong size sent" />
          </div>

          <div className="space-y-1">
            <Label htmlFor="rr-note">Explanation note</Label>
            <Textarea id="rr-note" data-testid="reroute-note" value={form.note} onChange={(e) => set("note")(e.target.value)} placeholder="What actually happened, for whoever answers it." />
          </div>

          {changed.length > 0 && (
            <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground" data-testid="reroute-change-note">
              Changing: <span className="font-medium text-foreground">{changed.join(", ")}</span>
              {rerouted ? " — the new lead gets one email." : " — no email will be sent."}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!canSave} onClick={() => void submit()}>{busy ? "Saving…" : "Save changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The re-route trail, shown under a case. Reads the append-only `rerouteHistory` array; a flag that was never
 *  edited renders nothing at all, so legacy records look exactly as they always did. */
export function RerouteHistory({ flag }: { flag: any }) {
  const rows: any[] = flag?.rerouteHistory ?? []
  if (!rows.length) return null
  return (
    <details className="mt-2 text-xs" data-testid="reroute-history">
      <summary className="cursor-pointer text-muted-foreground">
        Re-route history ({rows.length}) · last edited by {flag.editedBy ?? "unknown"}
      </summary>
      <ul className="mt-1 space-y-1 border-l pl-3">
        {rows.map((h, i) => {
          const moved = [h.previousTeam !== h.newTeam ? `${h.previousTeam} → ${h.newTeam}` : null, (h.previousAssignee ?? "") !== (h.newAssignee ?? "") ? `${h.previousAssignee ?? "unassigned"} → ${h.newAssignee ?? "unassigned"}` : null].filter(Boolean)
          return (
            <li key={i} className="text-muted-foreground">
              <span className="font-medium text-foreground">{h.editedBy}</span> · {dateTime(h.editedAt)}
              {" — "}
              {moved.length ? moved.join(", ") : `edited ${(h.changed ?? []).join(" + ") || "the case"}`}
              {h.emailNote ? ` · not emailed: ${h.emailNote}` : ""}
            </li>
          )
        })}
      </ul>
    </details>
  )
}
