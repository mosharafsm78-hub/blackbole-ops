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

export const Route = createFileRoute("/_app/accountability")({
  component: () => (
    <Guard perm="orders.view">
      <Accountability />
    </Guard>
  ),
})

const SLA_DAYS = 2
const TEAMS = ["Fulfillment", "Marketing", "Customer Care"]

function daysOpen(raisedAt: number) {
  return Math.floor((Date.now() - raisedAt) / 86400000)
}

function Row({ flag, canRespond }: { flag: any; canRespond: boolean }) {
  const respond = useMutation(api.accountability.respond)
  const [open, setOpen] = useState(false)
  const [response, setResponse] = useState("")
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!response.trim()) { toast.error("Write what was done about it before closing this out."); return }
    setBusy(true)
    try {
      await respond({ id: flag._id, response: response.trim() })
      toast.success("Closed out")
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
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
          {flag.note && <p className="mt-0.5 text-sm text-muted-foreground">"{flag.note}"</p>}
          <p className="mt-1 text-xs text-muted-foreground">Flagged by {flag.raisedByName} · {dateTime(flag.raisedAt)}</p>
        </div>
        {canRespond && (
          <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>{open ? "Cancel" : "Respond & close"}</Button>
        )}
      </div>
      {open && canRespond && (
        <div className="mt-3 space-y-2 border-t pt-3">
          <Textarea value={response} onChange={(e) => setResponse(e.target.value)} placeholder="What was actually done about it — re-checked the pick list, retrained the packer, etc." />
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

function Accountability() {
  const can = useCan()
  const flags = useQuery(api.accountability.listOpen)
  const canRespond = can("orders.accountability")
  const canRaise = can("team.manage")

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeader title="Accountability" sub="Returns confirmed to be our own mistake, routed to the person responsible — each one gets a real answer within 2 days, or it escalates." />
        {canRaise && <RaiseQuestion />}
      </div>
      {flags === undefined ? <Loading /> : flags.length === 0 ? (
        <Empty title="Nothing open">Every at-fault return and question has a response on record — this list stays empty until the next one comes in.</Empty>
      ) : (
        <div className="space-y-3">
          {flags.map((f) => <Row key={f._id} flag={f} canRespond={canRespond} />)}
        </div>
      )}
    </div>
  )
}
