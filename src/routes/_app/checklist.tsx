import { useEffect, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { useCan } from "@/components/app-shell"
import { Loading, PageHeader, Pill, TeamTag } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

// Open to every signed-in staff member: each department ticks its own steps.
export const Route = createFileRoute("/_app/checklist")({ component: ChecklistPage })

const DAY = 86400000
const TEAMS = ["Marketing", "Fulfillment", "Customer Care", "Development"]
const dm = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dhaka" })

function Step({ it }: { it: any }) {
  const tick = useMutation(api.checklist.tick)
  const remove = useMutation(api.checklist.removeStep)
  const can = useCan()
  const [busy, setBusy] = useState(false)
  const left = Math.ceil((it.dueAt - Date.now()) / DAY)
  const overdue = !it.doneAt && it.dueAt < Date.now()
  const toggle = async () => {
    setBusy(true)
    try { await tick({ id: it._id as Id<"checklistItems">, done: !it.doneAt }) } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <div className={cn("rounded-lg border bg-card p-3", overdue && "border-tone-red/50", it.doneAt && "opacity-70")} data-testid="step">
      <div className="flex items-start gap-3">
        <input type="checkbox" className="mt-1 size-5 shrink-0 accent-green-600" checked={!!it.doneAt} disabled={busy} onChange={() => void toggle()} aria-label={`Done: ${it.title}`} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className={cn("font-semibold", it.doneAt && "line-through")}>{it.title}</p>
            <TeamTag team={it.team} />
            {it.doneAt ? <Pill tone="green">Done {dm(it.doneAt)} · {it.doneBy}</Pill>
              : overdue ? <Pill tone="red">Overdue · was {dm(it.dueAt)}</Pill>
              : <Pill tone={left <= 2 ? "amber" : "gray"}>Due {dm(it.dueAt)}{left <= 7 ? ` · ${left <= 0 ? "today" : `${left} day${left === 1 ? "" : "s"}`}` : ""}</Pill>}
          </div>
          <p className="text-sm"><span className="font-semibold text-tone-green">Do:</span> {it.doText}</p>
          <p className="text-sm"><span className="font-semibold text-tone-red">Don't:</span> {it.dontText}</p>
          {it.custom && can("team.manage") && <button className="text-xs text-muted-foreground underline" onClick={() => void remove({ id: it._id }).catch((e) => toast.error(errMsg(e)))}>Remove this step</button>}
        </div>
      </div>
    </div>
  )
}

function AddStep({ phases }: { phases: string[] }) {
  const add = useMutation(api.checklist.addStep)
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ phase: phases[0] ?? "", team: TEAMS[0], title: "", doText: "", dontText: "", due: "" })
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }))
  if (!open) return <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Add a step</Button>
  return (
    <div className="space-y-2 rounded-lg border bg-card p-3">
      <Input placeholder="Step name" value={f.title} onChange={(e) => set("title", e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Select value={f.phase} onValueChange={(v) => set("phase", v)}><SelectTrigger className="w-64"><SelectValue /></SelectTrigger><SelectContent>{phases.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent></Select>
        <Select value={f.team} onValueChange={(v) => set("team", v)}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent>{TEAMS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select>
        <Input type="date" className="w-44" value={f.due} onChange={(e) => set("due", e.target.value)} />
      </div>
      <Textarea placeholder="Do: what exactly to do" value={f.doText} onChange={(e) => set("doText", e.target.value)} />
      <Textarea placeholder="Don't: what to avoid" value={f.dontText} onChange={(e) => set("dontText", e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void add(f).then(() => { toast.success("Step added"); setOpen(false); setF({ ...f, title: "", doText: "", dontText: "" }) }, (e) => toast.error(errMsg(e)))}>Add</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  )
}

function ChecklistPage() {
  const items = useQuery(api.checklist.list)
  const seed = useMutation(api.checklist.ensureSeeded)
  const can = useCan()
  useEffect(() => { if (items && items.length === 0) void seed({}) }, [items === undefined ? -1 : items.length])
  if (!items) return <Loading />
  const done = items.filter((i) => i.doneAt).length
  const overdue = items.filter((i) => !i.doneAt && i.dueAt < Date.now()).length
  const pct = items.length ? Math.round((done / items.length) * 100) : 0
  const phases: string[] = [...new Set<string>(items.map((i) => i.phase))]
  const next = items.filter((i) => !i.doneAt).sort((a, b) => a.dueAt - b.dueAt)[0]
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Route to Tk 1 crore a month" sub="Step by step: what to do, what not to do, and the deadline. Tick a step when it is really done. A step that misses its deadline goes to Accountability." />
      <div className="rounded-xl border bg-card p-4" data-testid="progress">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-2xl font-bold tabular-nums">{done} <span className="text-base font-medium text-muted-foreground">of {items.length} steps done</span></p>
          <div className="flex gap-2">{overdue > 0 && <Pill tone="red">{overdue} overdue</Pill>}<Pill tone="green">{pct}%</Pill></div>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-tone-green" style={{ width: `${pct}%` }} /></div>
        {next && <p className="mt-2 text-sm text-muted-foreground">Next deadline: <b className="text-foreground">{next.title}</b> · {dm(next.dueAt)}</p>}
        <p className="mt-1 text-xs text-muted-foreground">The money maths: Tk 1 crore is about Tk 3.3 lakh a day. At an order value near Tk 1,800 that is roughly 185 delivered orders a day. Watch the real numbers on the <Link to="/target" className="underline">Target page</Link>.</p>
      </div>
      {phases.map((ph) => {
        const rows = items.filter((i) => i.phase === ph)
        return (
          <section key={ph} className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{ph} · {rows.filter((r) => r.doneAt).length}/{rows.length}</h2>
            {rows.map((it) => <Step key={it._id} it={it} />)}
          </section>
        )
      })}
      {can("team.manage") && <AddStep phases={phases} />}
    </div>
  )
}
