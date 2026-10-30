import { useState } from "react"
import { useMutation } from "convex/react"
import { Archive, Plus, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

/** The recovery-workflow labels offered in the queue. Free text is still accepted by the backend, so a label
 *  added later never invalidates an existing record. */
export const RECOVERY_STATUSES = ["New", "Contacted", "Follow-up", "Interested", "Not interested", "Recovered"] as const

/** Everything the modal needs from a cart. Deliberately loose: legacy rows may be missing any of the newer
 *  fields, so each one is optional here and normalised on read. */
export type ModifiableCart = {
  _id: Id<"checkouts">
  customerName?: string | null
  phone?: string | null
  address?: string | null
  notes?: string | null
  discountCodes?: string[] | null
  recoveryStatus?: string | null
}

/** Turn a possibly-missing value into a safe string. Never returns null/undefined, so inputs stay controlled
 *  and React never flips a field from uncontrolled to controlled mid-edit. */
export const asText = (v: string | null | undefined): string => (typeof v === "string" ? v : "")

/** Same for the code list — a legacy row with no discountCodes becomes an empty array, not a crash. */
export const asCodes = (v: string[] | null | undefined): string[] =>
  Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : []

export function AbandonedModifyDialog({ cart, onClose }: { cart: ModifiableCart; onClose: () => void }) {
  const modify = useMutation(api.checkouts.modify)
  const archive = useMutation(api.checkouts.archive)

  // Seed every field from the cart, normalising missing values up front.
  const [name, setName] = useState(() => asText(cart.customerName))
  const [phone, setPhone] = useState(() => asText(cart.phone))
  const [address, setAddress] = useState(() => asText(cart.address))
  const [notes, setNotes] = useState(() => asText(cart.notes))
  const [codes, setCodes] = useState<string[]>(() => asCodes(cart.discountCodes))
  const [codeDraft, setCodeDraft] = useState("")
  const [recoveryStatus, setRecoveryStatus] = useState(() => asText(cart.recoveryStatus))
  const [busy, setBusy] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [archiveReason, setArchiveReason] = useState("")

  const addCode = () => {
    const t = codeDraft.trim().toUpperCase()
    if (!t) return
    setCodes((prev) => (prev.includes(t) ? prev : [...prev, t].slice(0, 10)))
    setCodeDraft("")
  }

  const save = async () => {
    setBusy(true)
    try {
      const res = await modify({
        id: cart._id,
        customerName: name,
        phone,
        address,
        notes,
        discountCodes: codes,
        recoveryStatus,
      })
      if (res.changed.length) toast.success(`Saved ${res.changed.length} change${res.changed.length > 1 ? "s" : ""}`)
      else toast.info("Nothing changed")
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const doArchive = async () => {
    setBusy(true)
    try {
      await archive({ id: cart._id, reason: archiveReason })
      toast.success("Archived — the record is kept and can be restored")
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="modify-dialog">
        <DialogHeader>
          <DialogTitle>Modify cart</DialogTitle>
          <DialogDescription>
            Fix a wrong number or address, add a note or discount code, and set where this lead stands.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mod-name">Customer name</Label>
              <Input id="mod-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mod-phone">Phone</Label>
              <Input id="mod-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="01712345678" inputMode="numeric" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mod-address">Address</Label>
            <Textarea id="mod-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Delivery address" rows={2} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mod-notes">Internal notes</Label>
            <Textarea
              id="mod-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
              placeholder="Anything the team should know — e.g. duplicate of an earlier lead"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Discount codes</Label>
            <div className="flex gap-2">
              <Input
                value={codeDraft} onChange={(e) => setCodeDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCode() } }}
                placeholder="e.g. SAVE10" className="uppercase"
              />
              <Button type="button" variant="outline" onClick={addCode} disabled={!codeDraft.trim()}>
                <Plus className="size-4" /> Add
              </Button>
            </div>
            {codes.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {codes.map((c) => (
                  <span key={c} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs font-medium">
                    {c}
                    <button type="button" aria-label={`Remove ${c}`} onClick={() => setCodes((p) => p.filter((x) => x !== c))} className="text-muted-foreground hover:text-foreground">
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No discount code on this cart yet.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Recovery status</Label>
            <div className="flex flex-wrap gap-1.5">
              {RECOVERY_STATUSES.map((s) => (
                <button
                  key={s} type="button" onClick={() => setRecoveryStatus(recoveryStatus === s ? "" : s)}
                  className={cn("rounded-full border px-3 py-1.5 text-sm", recoveryStatus === s ? "border-foreground bg-foreground text-background" : "hover:bg-accent")}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-tone-red/30 bg-tone-red/5 p-3">
            {!confirmArchive ? (
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground">
                  Duplicate or invalid entry? Archive it — the record is kept, not deleted.
                </div>
                <Button type="button" size="sm" variant="outline" className="shrink-0 border-tone-red text-tone-red" onClick={() => setConfirmArchive(true)}>
                  <Archive className="size-4" /> Archive
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="mod-reason">Why archive this cart?</Label>
                <Input id="mod-reason" value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)} placeholder="e.g. duplicate of 01712345678" />
                <div className="flex justify-end gap-2">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmArchive(false)}>Cancel</Button>
                  <Button type="button" size="sm" className="bg-tone-red text-white hover:bg-tone-red/90" disabled={busy} onClick={doArchive}>
                    {busy ? "Archiving…" : "Yes, archive"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
