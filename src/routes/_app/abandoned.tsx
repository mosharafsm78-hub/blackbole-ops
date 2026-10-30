import { useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Copy, MessageCircle, Pencil, PhoneCall, RotateCcw, ShoppingCart, ThumbsDown, Undo2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { Guard } from "@/components/app-shell"
import { ContactButtons, Empty, Loading, PageHeader, Pill } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"
import { AbandonedModifyDialog } from "@/components/abandoned-modify-dialog"

type Tab = "new" | "followup" | "converted" | "ordered" | "lost" | "archived"
const TABS: { k: Tab; label: string; hint: string }[] = [
  { k: "new", label: "New — call now", hint: "Left the website without ordering. Nobody has called yet." },
  { k: "followup", label: "Follow-up", hint: "Called at least once. Due calls first." },
  { k: "converted", label: "Recovered", hint: "We made the order after calling." },
  { k: "ordered", label: "Ordered on website", hint: "The customer finished the order on the website by themselves." },
  { k: "lost", label: "Not interested", hint: "Closed — the customer does not want it." },
  { k: "archived", label: "Archived", hint: "Hidden duplicates and invalid entries. Nothing is deleted — restore any of them." },
]

export const Route = createFileRoute("/_app/abandoned")({
  validateSearch: (s: Record<string, unknown>): { tab: Tab } => ({ tab: (TABS.some((t) => t.k === s.tab) ? s.tab : "new") as Tab }),
  component: () => (
    <Guard perm="orders.view">
      <AbandonedPage />
    </Guard>
  ),
})

const OUTCOMES = ["Will order later", "No answer", "Busy / call later", "Switched off", "Wrong number", "Price too high", "Asked for a different size / item"]
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}
const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })

type Row = NonNullable<ReturnType<typeof useQuery<typeof api.checkouts.list>>>[number]

function AbandonedPage() {
  const { tab } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const rows = useQuery(api.checkouts.list, { tab })
  const counts = useQuery(api.checkouts.counts)
  const [callFor, setCallFor] = useState<Row | null>(null)
  const [orderFor, setOrderFor] = useState<Row | null>(null)
  const [modifyFor, setModifyFor] = useState<Row | null>(null)
  const close = useMutation(api.checkouts.close)
  const unarchive = useMutation(api.checkouts.unarchive)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Abandoned carts"
        sub="Customers who filled in the website checkout or the COD form but did not order. Call them, then make the order here — it goes straight to Approved."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="To call now" value={counts ? String(counts.new) : "…"} tone="red" />
        <Kpi label="Follow-ups due" value={counts ? String(counts.followupDue) : "…"} tone="amber" sub={counts ? `${counts.followup} in follow-up` : undefined} />
        <Kpi label="Recovered (30 days)" value={counts ? taka(counts.recoveredValue30d) : "…"} tone="green" sub={counts ? `${counts.recovered30d} orders won back` : undefined} />
      </div>

      <div className="flex flex-wrap gap-2 rounded-xl border bg-card p-2">
        {TABS.map((t) => (
          <button
            key={t.k} type="button" onClick={() => navigate({ search: { tab: t.k } })} data-testid={`cart-tab-${t.k}`}
            className={cn("rounded-lg px-3 py-1.5 text-sm font-medium", tab === t.k ? "bg-foreground text-background" : "hover:bg-accent")}
          >
            {t.label}
            {counts ? <span className="ml-1.5 tabular-nums opacity-80">{(() => {
              const n = ({ new: counts.new, followup: counts.followup, converted: counts.recovered, ordered: counts.ordered, lost: counts.lost, archived: counts.archived } as Record<string, number>)[t.k] ?? 0
              return n >= 1000 ? "999+" : n
            })()}</span> : null}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{TABS.find((t) => t.k === tab)?.hint}</p>

      {rows === undefined || rows === null ? <Loading /> : rows.length === 0 ? (
        <Empty title={tab === "new" ? "No new abandoned carts" : tab === "archived" ? "Nothing archived" : "Nothing here"}>
          {tab === "new" ? "When a customer leaves the website checkout without ordering, they show up here after 15 minutes." : tab === "archived" ? "Carts you archive as duplicates or invalid entries are kept here." : null}
        </Empty>
      ) : (
        <div className="space-y-2">
          {rows.map((c) => (
            <CartRow
              key={c._id} c={c} tab={tab}
              onCall={() => setCallFor(c)} onOrder={() => setOrderFor(c)} onModify={() => setModifyFor(c)}
              onLost={async () => { try { await close({ id: c._id, status: "lost" }); toast.success("Moved to Not interested") } catch (e) { toast.error(errMsg(e)) } }}
              onReopen={async () => { try { await close({ id: c._id, status: "open" }); toast.success("Back in the call list") } catch (e) { toast.error(errMsg(e)) } }}
              onAlreadyOrdered={async () => { try { await close({ id: c._id, status: "ordered", orderId: c.laterOrder?.id }); toast.success("Marked as ordered") } catch (e) { toast.error(errMsg(e)) } }}
              onRestore={async () => { try { await unarchive({ id: c._id }); toast.success("Restored to the queue") } catch (e) { toast.error(errMsg(e)) } }}
            />
          ))}
        </div>
      )}

      {callFor && <CallDialog c={callFor} onClose={() => setCallFor(null)} onConfirmed={() => { const c = callFor; setCallFor(null); setOrderFor(c) }} />}
      {orderFor && <OrderDialog c={orderFor} onClose={() => setOrderFor(null)} />}
      {modifyFor && <AbandonedModifyDialog cart={modifyFor} onClose={() => setModifyFor(null)} />}
    </div>
  )
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: "red" | "amber" | "green" }) {
  return (
    <div className={cn("rounded-xl border border-t-[3px] bg-card px-4 py-3", tone === "red" ? "border-t-tone-red" : tone === "amber" ? "border-t-tone-amber" : "border-t-tone-green")}>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  )
}

function CartRow({ c, tab, onCall, onOrder, onModify, onLost, onReopen, onAlreadyOrdered, onRestore }: {
  c: Row; tab: Tab; onCall: () => void; onOrder: () => void; onModify: () => void; onLost: () => void; onReopen: () => void; onAlreadyOrdered: () => void; onRestore: () => void
}) {
  const open = tab === "new" || tab === "followup"
  const archived = tab === "archived"
  const due = c.followUpAt && c.followUpAt <= Date.now()
  const waText = `Assalamu Alaikum ${c.customerName || ""}, this is BlackBole. You left some items in your cart. ${c.recoveryUrl ? `You can finish your order here: ${c.recoveryUrl}` : "Shall we confirm the order for you?"}`
  return (
    <div className={cn("grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-[1.2fr_1.4fr_auto]", due && "border-tone-amber bg-tone-amber/5")} data-testid="cart-row">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{c.customerName || "No name given"}</span>
          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", c.kind === "codform" ? "bg-tone-amber/15 text-tone-amber" : c.kind === "draft" ? "bg-tone-violet/10 text-tone-violet" : "bg-tone-blue/10 text-tone-blue")}>
            {c.kind === "codform" ? "COD form · left without ordering" : c.kind === "draft" ? `COD form${c.shopName ? ` ${c.shopName}` : ""}` : "Website checkout"}
          </span>
          <span className="text-xs text-muted-foreground">{ago(c.shopUpdatedAt)}</span>
        </div>
        {c.phone ? (
          <div className="mt-1 flex items-center gap-2"><span className="tabular-nums">{c.phone}</span><ContactButtons phone={c.phone} /></div>
        ) : (
          <div className="mt-1 text-sm text-tone-red">No phone number{c.email ? ` · ${c.email}` : ""}</div>
        )}
        {c.address && <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{c.address}</div>}
        {c.recoveryStatus && (
          <div className="mt-1.5 inline-flex rounded bg-tone-violet/10 px-1.5 py-0.5 text-[10px] font-semibold text-tone-violet">{c.recoveryStatus}</div>
        )}
        {c.notes && <div className="mt-1 line-clamp-2 text-xs italic text-muted-foreground">Note: {c.notes}</div>}
        {c.discountCodes && c.discountCodes.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {c.discountCodes.map((code) => (
              <span key={code} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold">{code}</span>
            ))}
          </div>
        )}
        {archived && (
          <div className="mt-1.5 text-xs text-muted-foreground">
            Archived{c.archivedBy ? ` by ${c.archivedBy}` : ""}{c.archivedAt ? ` · ${when(c.archivedAt)}` : ""}
            {c.archiveReason ? ` — ${c.archiveReason}` : ""}
          </div>
        )}
        {c.laterOrder && open && (
          <div className="mt-2 inline-flex items-center gap-2 rounded-md bg-tone-green/10 px-2 py-1 text-xs font-medium text-tone-green">
            Ordered later: <Link to="/order" search={{ id: c.laterOrder.id }} className="underline">{c.laterOrder.invoice}</Link>
            <button type="button" className="underline" onClick={onAlreadyOrdered}>mark done</button>
          </div>
        )}
      </div>

      <div className="min-w-0 text-sm">
        {c.items.map((i, k) => (
          <div key={k} className={cn(!i.variantId && "text-tone-red")}>{i.qty} × {i.name}{i.attrs ? ` · ${i.attrs}` : ""}</div>
        ))}
        <div className="mt-1 font-semibold">{taka(c.total)}</div>
        {c.callCount > 0 && (
          <div className="mt-2 rounded-md bg-muted/60 px-2 py-1 text-xs">
            <b>{c.callCount} call{c.callCount > 1 ? "s" : ""}</b> · {c.lastOutcome}{c.lastNote ? ` — ${c.lastNote}` : ""}{c.lastCallBy ? ` · ${c.lastCallBy}` : ""}
            {c.followUpAt && <div className={cn("font-semibold", due ? "text-tone-red" : "text-tone-amber")}>Call again {when(c.followUpAt)}</div>}
          </div>
        )}
        {c.orderInvoice && c.orderId && (
          <div className="mt-2 text-xs">Order: <Link to="/order" search={{ id: c.orderId }} className="font-semibold text-tone-blue hover:underline">{c.orderInvoice}</Link>{c.closedBy ? ` · by ${c.closedBy}` : ""}</div>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-2 md:flex-col md:items-stretch">
        {archived ? (
          <Button size="sm" variant="outline" onClick={onRestore}><RotateCcw className="size-4" /> Restore</Button>
        ) : open ? (
          <>
            <Button size="sm" onClick={onCall} disabled={!c.phone}><PhoneCall className="size-4" /> Log call</Button>
            <Button size="sm" variant="outline" className="border-tone-green text-tone-green" onClick={onOrder} disabled={!c.phone}><ShoppingCart className="size-4" /> Make order</Button>
            <Button size="sm" variant="outline" onClick={onModify}><Pencil className="size-4" /> Modify</Button>
            {c.phone && (
              <Button size="sm" variant="outline" asChild>
                <a href={`https://wa.me/88${c.phone}?text=${encodeURIComponent(waText)}`} target="_blank" rel="noreferrer"><MessageCircle className="size-4 text-tone-green" /> WhatsApp</a>
              </Button>
            )}
            {c.recoveryUrl && (
              <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(c.recoveryUrl!); toast.success("Checkout link copied") }}><Copy className="size-4" /> Cart link</Button>
            )}
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onLost}><ThumbsDown className="size-4" /> Not interested</Button>
          </>
        ) : tab === "lost" ? (
          <div className="flex flex-col gap-2">
            <Button size="sm" variant="outline" onClick={onReopen}><Undo2 className="size-4" /> Call again</Button>
            <Button size="sm" variant="ghost" onClick={onModify}><Pencil className="size-4" /> Modify</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Pill tone={tab === "converted" ? "green" : "blue"}>{tab === "converted" ? "Recovered" : "Ordered"}</Pill>
            <Button size="sm" variant="ghost" onClick={onModify}><Pencil className="size-4" /> Modify</Button>
          </div>
        )}
      </div>
    </div>
  )
}

function CallDialog({ c, onClose, onConfirmed }: { c: Row; onClose: () => void; onConfirmed: () => void }) {
  const log = useMutation(api.checkouts.logCall)
  const [outcome, setOutcome] = useState(OUTCOMES[0])
  const [note, setNote] = useState("")
  const toLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  const at = (days: number, hour: number) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return toLocal(d) }
  const [followUp, setFollowUp] = useState(at(1, 11))
  const needsFollow = ["Will order later", "No answer", "Busy / call later", "Switched off"].includes(outcome)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Call {c.customerName || c.phone}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <Button className="w-full bg-tone-green text-white hover:bg-tone-green/90" onClick={onConfirmed}>Customer confirmed — make the order</Button>
          <div className="flex flex-wrap gap-2">
            {OUTCOMES.map((o) => (
              <button key={o} type="button" onClick={() => setOutcome(o)}
                className={cn("rounded-full border px-3 py-1.5 text-sm", outcome === o ? "border-foreground bg-foreground text-background" : "hover:bg-accent")}>{o}</button>
            ))}
          </div>
          {needsFollow && (
            <div className="space-y-1.5 rounded-lg border border-tone-amber/40 bg-tone-amber/5 p-3">
              <Label>Call again on</Label>
              <div className="flex flex-wrap gap-1.5">
                {[["In 2 hours", toLocal(new Date(Date.now() + 2 * 3600000))], ["This evening", at(0, 19)], ["Tomorrow", at(1, 11)], ["In 2 days", at(2, 11)]].map(([l, v]) => (
                  <button key={l} type="button" onClick={() => setFollowUp(v)}
                    className={cn("rounded-md border px-2.5 py-1 text-xs", followUp === v ? "border-foreground bg-foreground text-background" : "bg-background hover:bg-accent")}>{l}</button>
                ))}
              </div>
              <input type="datetime-local" value={followUp} onChange={(e) => setFollowUp(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm" />
            </div>
          )}
          <div className="space-y-1.5"><Label>Note</Label><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did the customer say?" /></div>
        </div>
        <DialogFooter>
          <Button disabled={busy} onClick={async () => {
            setBusy(true)
            try {
              await log({ id: c._id, outcome, note, followUpAt: needsFollow && followUp ? new Date(followUp).getTime() : undefined })
              toast.success("Call saved"); onClose()
            } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
          }}>Save call</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function OrderDialog({ c, onClose }: { c: Row; onClose: () => void }) {
  const convert = useMutation(api.checkouts.convert)
  const navigate = useNavigate()
  const [name, setName] = useState(c.customerName)
  const [phone, setPhone] = useState(c.phone)
  const [address, setAddress] = useState(c.address)
  const [fee, setFee] = useState(c.deliveryFee || 130)
  const [status, setStatus] = useState<"approved" | "pending">("approved")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const itemsTotal = c.items.reduce((s, i) => s + i.price * i.qty - i.discount, 0) - c.discount
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Make order from this cart</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            {c.items.map((i, k) => <div key={k} className={cn(!i.variantId && "text-tone-red")}>{i.qty} × {i.name}{i.attrs ? ` · ${i.attrs}` : ""} — {taka(i.price * i.qty - i.discount)}</div>)}
            {c.items.some((i) => !i.variantId) && <div className="mt-1 text-xs text-tone-red">Red items are not matched to our products (stock won't move). Fix the SKU on the order after.</div>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Phone</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          </div>
          <div className="space-y-1.5"><Label>Address</Label><Textarea value={address} onChange={(e) => setAddress(e.target.value)} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Delivery fee</Label><Input type="number" value={fee} onChange={(e) => setFee(Number(e.target.value) || 0)} /></div>
            <div className="space-y-1.5">
              <Label>Put the order in</Label>
              <div className="flex overflow-hidden rounded-md border text-sm">
                <button type="button" onClick={() => setStatus("approved")} className={cn("flex-1 px-3 py-2", status === "approved" ? "bg-foreground text-background" : "")}>Approved</button>
                <button type="button" onClick={() => setStatus("pending")} className={cn("flex-1 px-3 py-2", status === "pending" ? "bg-foreground text-background" : "")}>Pending</button>
              </div>
            </div>
          </div>
          <div className="space-y-1.5"><Label>Note for the team (optional)</Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. customer wants delivery after 5 pm" /></div>
          <div className="text-right text-sm">Total to collect: <b>{taka(itemsTotal + fee)}</b></div>
        </div>
        <DialogFooter>
          <Button disabled={busy} onClick={async () => {
            setBusy(true)
            try {
              const r = await convert({ id: c._id as Id<"checkouts">, customerName: name, phone, address, deliveryFee: fee, status, note })
              toast.success(`Order BB-${r.invoiceNo} created`)
              onClose()
              navigate({ to: "/order", search: { id: r.orderId } })
            } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
          }}>{busy ? "Creating…" : "Create order"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export type { Doc }
