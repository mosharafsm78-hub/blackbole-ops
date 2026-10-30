import { useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Guard, useCan } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill, TeamTag } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dateTime, errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"
import { RerouteDialog, RerouteHistory } from "@/components/accountability-reroute-dialog"

export const Route = createFileRoute("/_app/accountability")({
  validateSearch: (s: Record<string, unknown>): { tab: View } => ({ tab: s.tab === "closed" ? "closed" : "open" }),
  component: () => (
    <Guard perm="orders.view">
      <Accountability />
    </Guard>
  ),
})

type View = "open" | "closed"

const SLA_DAYS = 2
const TEAMS = ["Fulfillment", "Marketing", "Customer Care"]

function daysOpen(raisedAt: number) {
  return Math.floor((Date.now() - raisedAt) / 86400000)
}

/** CAPA — Corrective & Preventive Action, the standard industry format for closing out an accountability item.
 *  Three required fields, not one free-text box, so a response is a real answer the team is held to, not a
 *  one-line excuse. */
function Row({ flag, canRespond, canReroute }: { flag: any; canRespond: boolean; canReroute: boolean }) {
  const respond = useMutation(api.accountability.respond)
  const archive = useMutation(api.accountability.archive)
  const [rerouteOpen, setRerouteOpen] = useState(false)
  const [open, setOpen] = useState(false)
  const [rootCause, setRootCause] = useState("")
  const [correctiveAction, setCorrectiveAction] = useState("")
  const [preventiveAction, setPreventiveAction] = useState("")
  const [busy, setBusy] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      await respond({ id: flag._id, rootCause: rootCause.trim(), correctiveAction: correctiveAction.trim(), preventiveAction: preventiveAction.trim() })
      toast.success("Closed out")
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  /** Soft-archive: the case leaves the open queue but is never deleted, and lands in Closed cases with who did it
   *  and when. Guarded so a double-click can't fire twice. */
  const archiveCase = async () => {
    if (archiving) return
    setArchiving(true)
    try {
      const res = await archive({ id: flag._id })
      toast.success(res.alreadyArchived ? "Already archived" : "Archived — moved to Closed cases")
    } catch (e) { toast.error(errMsg(e)) } finally { setArchiving(false) }
  }
  const days = daysOpen(flag.raisedAt)
  const overdue = days >= SLA_DAYS
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <TeamTag team={flag.team} />
            {flag.orderInvoice ? (
              <>
                <Link to="/order" search={{ id: flag.orderId as Id<"orders"> }} className="font-semibold underline underline-offset-2">{flag.orderInvoice}</Link>
                <span className="text-sm text-muted-foreground">{flag.customerName} · {flag.phone}</span>
              </>
            ) : (
              <Pill tone="violet">Question</Pill>
            )}
            {flag.assignee && <Pill tone="blue">→ {flag.assignee}</Pill>}
            {overdue && <Pill tone="red">{days} day{days === 1 ? "" : "s"} open{flag.escalatedAt ? " · escalated" : ""}</Pill>}
          </div>
          <p className="mt-1 text-sm font-medium text-tone-red">{flag.reason}</p>
          {(flag as any).productNames?.length > 0 && (
            <p className="mt-0.5 text-sm text-muted-foreground">{(flag as any).productNames.join(", ")}</p>
          )}
          {flag.note && <p className="mt-0.5 text-sm text-muted-foreground">"{flag.note}"</p>}
          <p className="mt-1 text-xs text-muted-foreground">Flagged by {flag.raisedByName} · {dateTime(flag.raisedAt)}</p>
          {flag.editedBy && <p className="text-xs text-muted-foreground">Edited by {flag.editedBy} · {dateTime(flag.editedAt)}</p>}
          <RerouteHistory flag={flag} />
        </div>
        {(canRespond || canReroute) && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {canReroute && (
              <Button variant="ghost" size="sm" data-testid="reroute-open" onClick={() => setRerouteOpen(true)}>Edit / Re-route</Button>
            )}
            {canRespond && (
              <>
                <Button variant="ghost" size="sm" disabled={archiving} onClick={() => void archiveCase()}>Archive</Button>
                <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>{open ? "Cancel" : "Respond & close"}</Button>
              </>
            )}
          </div>
        )}
      </div>
      {canReroute && <RerouteDialog flag={flag} open={rerouteOpen} onOpenChange={setRerouteOpen} />}
      {open && canRespond && (
        <div className="mt-3 space-y-3 border-t pt-3">
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Root cause — what actually went wrong</label>
            <Textarea value={rootCause} onChange={(e) => setRootCause(e.target.value)} placeholder="The real reason, not an excuse — e.g. the picker read the order list off an old printout instead of the screen." />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Corrective action — what was done about this case</label>
            <Textarea value={correctiveAction} onChange={(e) => setCorrectiveAction(e.target.value)} placeholder="What was actually done — e.g. customer refunded/exchanged, item re-picked and verified." />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preventive action — what stops this happening again</label>
            <Textarea value={preventiveAction} onChange={(e) => setPreventiveAction(e.target.value)} placeholder="A concrete process change, not a promise — e.g. pickers now scan the SKU barcode before sealing every parcel." />
          </div>
          <Button size="sm" disabled={busy} onClick={() => void submit()}>Close out</Button>
        </div>
      )}
    </div>
  )
}

/** Raise a free-form, non-order question — "why is our return ratio high this month" — routed to a team the
 *  same way an order-triggered flag is, with the same mandatory-response 2-day SLA. Gated the same as
 *  Settings → Team/Roles, since it's meant for ops leadership to open, not every CX agent. */
function RaiseQuestion() {
  const raise = useMutation(api.accountability.raiseFreeform)
  const [open, setOpen] = useState(false)
  const [team, setTeam] = useState<string>(TEAMS[0])
  const [question, setQuestion] = useState("")
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!question.trim()) { toast.error("Write the question first."); return }
    setBusy(true)
    try {
      await raise({ team, question: question.trim() })
      toast.success("Raised")
      setOpen(false); setQuestion("")
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Raise a question</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Raise a question</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Not tied to one order — a pattern, a trend, anything that needs a named answer within {SLA_DAYS} days.</p>
            <Select value={team} onValueChange={setTeam}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{TEAMS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
            <Textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Why is our return ratio high this month?" />
          </div>
          <DialogFooter>
            <Button disabled={busy} onClick={() => void submit()}>Raise</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** One closed case, read-only. Everything needed to review it historically is on the row: who closed it, when,
 *  why, and the linked order — no click required, and nothing here is editable. */
function ClosedRow({ c, canRestore }: { c: any; canRestore: boolean }) {
  const unarchive = useMutation(api.accountability.unarchive)
  const [busy, setBusy] = useState(false)
  const archived = c.outcome === "archived"
  const restore = async () => {
    setBusy(true)
    try {
      await unarchive({ id: c._id })
      toast.success("Back in the open queue")
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <div className="rounded-lg border bg-card p-4" data-testid="closed-case">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <TeamTag team={c.team} />
            {archived ? <Pill tone="gray">Archived</Pill> : <Pill tone="green">Answered</Pill>}
            {c.orderInvoice ? (
              <>
                <Link to="/order" search={{ id: c.orderId as Id<"orders"> }} className="font-semibold underline underline-offset-2">{c.orderInvoice}</Link>
                {c.customerName && <span className="text-sm text-muted-foreground">{c.customerName}{c.phone ? ` · ${c.phone}` : ""}</span>}
              </>
            ) : (
              <Pill tone="violet">Question</Pill>
            )}
          </div>
          <p className="mt-1 text-sm font-medium">{c.reason}</p>
          {(c as any).productNames?.length > 0 && (
            <p className="mt-0.5 text-sm text-muted-foreground">{(c as any).productNames.join(", ")}</p>
          )}
          {c.note && <p className="mt-0.5 text-sm text-muted-foreground">"{c.note}"</p>}

          {archived ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Archived by <span className="font-medium text-foreground">{c.archivedBy ?? "unknown"}</span> · {dateTime(c.archivedAt)}
              {c.archiveReason ? ` — ${c.archiveReason}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Closed by <span className="font-medium text-foreground">{c.resolvedByName ?? "unknown"}</span> · {dateTime(c.resolvedAt ?? c.closedAt)}
            </p>
          )}

          <RerouteHistory flag={c} />

          {!archived && c.response && (
            <div className="mt-2 space-y-1 rounded-md bg-muted/50 p-2 text-sm">
              {c.rootCause && <p><span className="font-semibold">Root cause:</span> {c.rootCause}</p>}
              {c.correctiveAction && <p><span className="font-semibold">Fix:</span> {c.correctiveAction}</p>}
              {c.preventiveAction && <p><span className="font-semibold">Prevention:</span> {c.preventiveAction}</p>}
            </div>
          )}
        </div>
        {archived && canRestore && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void restore()}>Restore</Button>
        )}
      </div>
    </div>
  )
}

function ClosedCases({ canRestore }: { canRestore: boolean }) {
  const [team, setTeam] = useState<string>("all")
  const rows = useQuery(api.accountability.listClosed, team === "all" ? {} : { team })
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Read-only history — every case that has left the open queue, answered or archived. Nothing here can be edited.</p>
        <Select value={team} onValueChange={setTeam}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All departments</SelectItem>
            {TEAMS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {rows === undefined ? <Loading /> : rows.length === 0 ? (
        <Empty title="No closed cases yet">Cases appear here once a department answers them, or once a duplicate is archived.</Empty>
      ) : (
        <div className="space-y-3">
          {rows.map((c) => <ClosedRow key={c._id} c={c} canRestore={canRestore} />)}
        </div>
      )}
    </div>
  )
}

function Accountability() {
  const can = useCan()
  const { tab } = Route.useSearch()
  const navigate = Route.useNavigate()
  const flags = useQuery(api.accountability.listOpen)
  const closed = useQuery(api.accountability.listClosed, {})
  const canRespond = can("orders.accountability")
  const canRaise = can("team.manage")
  // Editing / re-routing rewrites a case's history, so it is Super Admin only — the same wildcard check the
  // other "only a Super Admin can change a logged record" paths use.
  const canReroute = can("*")

  const tabs: { k: View; label: string; count?: number }[] = [
    { k: "open", label: "Open", count: flags?.length },
    { k: "closed", label: "Closed cases", count: closed?.length },
  ]

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeader title="Accountability" sub="Returns confirmed to be our own mistake, routed to the person responsible — each one gets a real answer within 2 days, or it escalates." />
        {canRaise && <RaiseQuestion />}
      </div>

      <div className="flex flex-wrap gap-1" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.k} type="button" role="tab" aria-selected={tab === t.k}
            onClick={() => void navigate({ search: { tab: t.k } })}
            data-testid={`accountability-tab-${t.k}`}
            className={cn("rounded-lg px-3 py-1.5 text-sm font-medium", tab === t.k ? "bg-foreground text-background" : "hover:bg-accent")}
          >
            {t.label}
            {t.count !== undefined && <span className="ml-1.5 tabular-nums opacity-80">{t.count}</span>}
          </button>
        ))}
      </div>

      {tab === "closed" ? (
        <ClosedCases canRestore={canRespond} />
      ) : flags === undefined ? <Loading /> : flags.length === 0 ? (
        <Empty title="Nothing open">Every at-fault return and question has a response on record — this list stays empty until the next one comes in.</Empty>
      ) : (
        <div className="space-y-3">
          {flags.map((f) => <Row key={f._id} flag={f} canRespond={canRespond} canReroute={canReroute} />)}
        </div>
      )}
    </div>
  )
}
