import { useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ImagePlus, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Pill } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dateTime, errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const KIND_LABEL: Record<string, string> = { live_picture: "Live picture", exchange: "Exchange", question: "Question", other: "Other" }
const KIND_TONE: Record<string, any> = { live_picture: "violet", exchange: "orange", question: "blue", other: "gray" }

type Photo = { id: Id<"_storage">; url: string }

/** Picks photos, uploads them straight to storage, and hands back their ids. */
function usePhotos() {
  const getUrl = useMutation(api.teamRequests.uploadUrl)
  const [photos, setPhotos] = useState<Photo[]>([])
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const add = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    try {
      for (const f of Array.from(files)) {
        if (!f.type.startsWith("image/")) { toast.error(`${f.name} is not a picture`); continue }
        const url = await getUrl({})
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": f.type }, body: f })
        if (!res.ok) throw new Error("Upload failed — try again")
        const { storageId } = await res.json()
        setPhotos((p) => [...p, { id: storageId, url: URL.createObjectURL(f) }])
      }
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false); if (input.current) input.current.value = "" }
  }
  const picker = (
    <div className="flex flex-wrap items-center gap-2">
      {photos.map((p) => (
        <div key={p.id} className="relative">
          <img src={p.url} alt="" className="size-16 rounded-md border object-cover" />
          <button type="button" onClick={() => setPhotos((x) => x.filter((y) => y.id !== p.id))} className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground p-0.5 text-background"><X className="size-3" /></button>
        </div>
      ))}
      <input ref={input} type="file" accept="image/*" multiple className="hidden" onChange={(e) => add(e.target.files)} />
      <Button type="button" size="sm" variant="outline" disabled={busy || photos.length >= 6} onClick={() => input.current?.click()}>
        <ImagePlus className="size-4" /> {busy ? "Uploading…" : "Add photo"}
      </Button>
    </div>
  )
  return { ids: photos.map((p) => p.id), picker, reset: () => setPhotos([]), busy }
}

export function NewRequestDialog({ open, onOpenChange, orderId, invoice, defaultKind }: { open: boolean; onOpenChange: (o: boolean) => void; orderId?: Id<"orders">; invoice?: string; defaultKind?: string }) {
  const people = useQuery(api.teamRequests.people) ?? []
  const me = useQuery(api.team.me)
  const create = useMutation(api.teamRequests.create)
  const [kind, setKind] = useState(defaultKind ?? "live_picture")
  const [to, setTo] = useState("")
  const [msg, setMsg] = useState("")
  const [busy, setBusy] = useState(false)
  const ph = usePhotos()
  const myId = me && me.kind === "ok" ? me.staff._id : null
  const submit = async () => {
    setBusy(true)
    try {
      await create({ kind, toStaffId: to as Id<"staff">, message: msg, orderId, photoIds: ph.ids })
      toast.success("Request sent")
      setMsg(""); setTo(""); ph.reset(); onOpenChange(false)
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New request{invoice ? ` · ${invoice}` : ""}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">What do you need?</div>
              <Select value={kind} onValueChange={(v) => setKind(v ?? "other")}>
                <SelectTrigger><SelectValue>{KIND_LABEL[kind]}</SelectValue></SelectTrigger>
                <SelectContent>{Object.entries(KIND_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l === "Live picture" ? "Live picture of the product" : l === "Exchange" ? "Exchange request" : l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Ask who?</div>
              <Select value={to} onValueChange={(v) => setTo(v ?? "")}>
                <SelectTrigger><SelectValue placeholder="Pick a person">{people.find((p) => p._id === to)?.name}</SelectValue></SelectTrigger>
                <SelectContent>{people.filter((p) => p._id !== myId).map((p) => <SelectItem key={p._id} value={p._id}>{p.name}{p.role ? ` · ${p.role}` : ""}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <Textarea rows={4} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={kind === "live_picture" ? "Which product and size? The customer wants a real photo." : kind === "exchange" ? "What should be exchanged, for which size or product?" : "Write what you need…"} />
          {ph.picker}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || ph.busy || !to || !msg.trim()} onClick={submit}>{busy ? "Sending…" : "Send request"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Photos({ urls }: { urls: string[] }) {
  if (!urls.length) return null
  return <div className="mt-1.5 flex flex-wrap gap-2">{urls.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="" className="size-24 rounded-md border object-cover" /></a>)}</div>
}

export function RequestCard({ r, meId, showOrder = true }: { r: any; meId: string | null; showOrder?: boolean }) {
  const reply = useMutation(api.teamRequests.reply)
  const close = useMutation(api.teamRequests.close)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const ph = usePhotos()
  const mine = meId === r.toStaffId || meId === r.fromStaffId
  const waitingFor = r.status === "open" ? r.toName : r.status === "answered" ? r.fromName : null
  const waitH = (Date.now() - r.updatedAt) / 3600_000
  const send = async () => {
    setBusy(true)
    try { await reply({ id: r._id, text, photoIds: ph.ids }); setText(""); ph.reset() } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <div className="rounded-xl border bg-card p-3.5 shadow-xs">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Pill tone={KIND_TONE[r.kind] ?? "gray"}>{KIND_LABEL[r.kind] ?? r.kind}</Pill>
        <span className="font-semibold">{r.fromName}</span><span className="text-muted-foreground">asked</span><span className="font-semibold">{r.toName}</span>
        {showOrder && r.orderId && <Link to="/order" search={{ id: r.orderId }} className="font-semibold text-tone-blue hover:underline">{r.invoice}{r.customerName ? ` · ${r.customerName}` : ""}</Link>}
        <span className="ml-auto text-xs text-muted-foreground">{dateTime(r.createdAt)}</span>
      </div>
      <div className="mt-2 whitespace-pre-wrap text-sm">{r.message}</div>
      <Photos urls={r.photos} />
      {r.replies.map((x: any, i: number) => (
        <div key={i} className={cn("mt-2 rounded-lg px-3 py-2 text-sm", x.byStaffId === r.toStaffId ? "bg-tone-green-bg" : "bg-muted")}>
          <div className="text-xs font-semibold">{x.byName} <span className="font-normal text-muted-foreground">· {dateTime(x.at)}</span></div>
          {x.text && <div className="whitespace-pre-wrap">{x.text}</div>}
          <Photos urls={x.photos} />
        </div>
      ))}
      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
        {r.status === "done" ? <Pill tone="gray">Closed by {r.doneByName}</Pill>
          : <Pill tone={r.status === "open" ? (waitH >= 2 ? "red" : "amber") : "green"}>{r.status === "open" ? `Waiting for ${waitingFor}${waitH >= 1 ? ` · ${Math.floor(waitH)}h` : ""}` : `Answered — ${waitingFor} to check`}</Pill>}
      </div>
      {r.status !== "done" && mine && (
        <div className="mt-2.5 space-y-2 border-t pt-2.5">
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={meId === r.toStaffId ? "Write your answer…" : "Add a message…"} />
          {ph.picker}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || ph.busy || (!text.trim() && ph.ids.length === 0)} onClick={send}>{busy ? "Sending…" : meId === r.toStaffId ? "Send answer" : "Send message"}</Button>
            <Button size="sm" variant="outline" onClick={() => close({ id: r._id }).catch((e) => toast.error(errMsg(e)))}>Mark done</Button>
          </div>
        </div>
      )}
    </div>
  )
}
