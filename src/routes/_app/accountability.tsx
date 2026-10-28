import { useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Guard, useCan } from "@/components/app-shell"
import { Empty, Loading, PageHeader, TeamTag } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { dateTime, errMsg } from "@/lib/format"

export const Route = createFileRoute("/_app/accountability")({
  component: () => (
    <Guard perm="orders.view">
      <Accountability />
    </Guard>
  ),
})

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
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <TeamTag team={flag.team} />
            <Link to="/order" search={{ id: flag.orderId as Id<"orders"> }} className="font-semibold underline underline-offset-2">{flag.orderInvoice}</Link>
            <span className="text-sm text-muted-foreground">{flag.customerName} · {flag.phone}</span>
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

function Accountability() {
  const can = useCan()
  const flags = useQuery(api.accountability.listOpen)
  const canRespond = can("orders.accountability")

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Accountability" sub="Returns confirmed to be our own mistake, routed to the department that caused it — each one gets a real answer before it closes out." />
      {flags === undefined ? <Loading /> : flags.length === 0 ? (
        <Empty title="Nothing open">Every at-fault return has a response on record — this list stays empty until the next one comes in.</Empty>
      ) : (
        <div className="space-y-3">
          {flags.map((f) => <Row key={f._id} flag={f} canRespond={canRespond} />)}
        </div>
      )}
    </div>
  )
}
