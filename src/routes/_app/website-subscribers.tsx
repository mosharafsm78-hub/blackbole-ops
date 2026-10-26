// Customers → Subscribers (like Shopify's customers list filtered to email subscribers): people who joined the
// newsletter on the website. Search, filter by where they signed up, sort, tick rows to export or remove, add by hand.
import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Download, Mail, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { WebsiteTabs } from "@/components/discount-ui"
import { Badge, Card, EmptyState, Field, FilterChoices, FilterPill, IndexSearch, IndexTable, PageHeader, useSelection, useSort } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { dateTime, errMsg } from "@/lib/format"

export const Route = createFileRoute("/_app/website-subscribers")({
  component: () => <WebsiteGuard><Subscribers /></WebsiteGuard>,
})

type Row = { _id: Id<"subscribers">; email: string; name: string; phone: string; source: string; tags: string; createdAt: number; updatedAt: number }
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
const SOURCE: Record<string, string> = { footer: "Website footer", checkout: "Checkout", manual: "Added by staff", popup: "Pop-up" }
const sourceLabel = (s: string) => SOURCE[s] ?? s.charAt(0).toUpperCase() + s.slice(1)
const PAGE = 50

function Subscribers() {
  const rows = useQuery(api.subscribers.list) as Row[] | null | undefined
  const remove = useMutation(api.subscribers.remove)
  const [q, setQ] = useState("")
  const [source, setSource] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [adding, setAdding] = useState(false)
  const sort = useSort<"name" | "email" | "date">("date", "desc")
  const sources = useMemo(() => [...new Set((rows ?? []).map((r) => r.source))].sort(), [rows])
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    const out = (rows ?? []).filter((r) => (!source || r.source === source) && (!s || r.email.includes(s) || r.name.toLowerCase().includes(s) || r.phone.includes(s)))
    const k = sort.dir === "asc" ? 1 : -1
    return out.sort((a, b) => k * (sort.by === "date" ? a.createdAt - b.createdAt : sort.by === "email" ? a.email.localeCompare(b.email) : (a.name || "~").localeCompare(b.name || "~")))
  }, [rows, q, source, sort.by, sort.dir])
  const pages = Math.max(1, Math.ceil(list.length / PAGE))
  const shown = list.slice(page * PAGE, page * PAGE + PAGE)
  const sel = useSelection(list.map((r) => r._id))

  const download = (which: Row[]) => {
    const lines = ["email,name,phone,source,signed_up", ...which.map((r) => [r.email, r.name, r.phone, r.source, new Date(r.createdAt).toISOString()].map(csvCell).join(","))]
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }))
    const a = document.createElement("a")
    a.href = url; a.download = `blackbole-subscribers-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mx-auto max-w-6xl">
      <WebsiteTabs active="subscribers" />
      <PageHeader title="Subscribers" subtitle="People who joined the newsletter on the website."
        secondary={<Button size="sm" variant="outline" disabled={!list.length} onClick={() => download(list)}><Download className="size-4" /> Export</Button>}
        primary={<Button size="sm" onClick={() => setAdding(true)}>Add subscriber</Button>} />

      {rows === undefined ? <Loading /> : rows === null ? null : rows.length === 0 ? (
        <Card><EmptyState icon={<Mail />} title="No subscribers yet" text="Sign-ups from the website footer appear here." primary={<Button size="sm" onClick={() => setAdding(true)}>Add subscriber</Button>} /></Card>
      ) : (
        <Card flush>
          <div className="flex items-center gap-2 border-b px-4 py-2 text-[13px]">
            <span className="font-semibold tabular-nums">{rows.length} subscriber{rows.length === 1 ? "" : "s"}</span>
            {list.length !== rows.length && <span className="text-muted-foreground">· {list.length} shown</span>}
          </div>
          <IndexSearch value={q} onChange={(v) => { setQ(v); setPage(0) }} placeholder="Search by name, email or phone" pills={sources.length > 1 ? (
            <FilterPill label="Signed up from" value={source ? sourceLabel(source) : undefined} onClear={() => setSource(null)}>
              <FilterChoices options={sources.map((s) => ({ value: s, label: sourceLabel(s) }))} value={source} onChange={(v) => { setSource(v); setPage(0) }} />
            </FilterPill>
          ) : undefined} />
          <IndexTable<Row>
            rows={shown} rowId={(r) => r._id} sel={sel} total={list.length}
            sort={sort} onSort={(k) => sort.toggle(k as "name" | "email" | "date")}
            bulk={<Button size="sm" variant="outline" onClick={() => download(list.filter((r) => sel.has(r._id)))}><Download className="size-4" /> Export</Button>}
            bulkMore={[{ label: "Remove from list", destructive: true, icon: <Trash2 className="size-4" />, onClick: async () => {
              if (!window.confirm(`Remove ${sel.count} subscriber${sel.count === 1 ? "" : "s"} from the list?`)) return
              try { const n = await remove({ ids: [...sel.selected] as Id<"subscribers">[] }); sel.clear(); toast.success(`${n} removed`) } catch (e) { toast.error(errMsg(e)) }
            } }]}
            empty={<p className="px-4 py-10 text-center text-sm text-muted-foreground">No one matches.</p>}
            columns={[
              { key: "name", label: "Customer name", sortable: true, render: (r) => <span className="font-semibold">{r.name || <span className="font-normal text-muted-foreground">No name</span>}</span> },
              { key: "email", label: "Email", sortable: true, render: (r) => <a href={`mailto:${r.email}`} onClick={(e) => e.stopPropagation()} className="hover:underline">{r.email}</a> },
              { key: "phone", label: "Phone", hideBelow: "md", render: (r) => <span className="text-muted-foreground">{r.phone || "—"}</span> },
              { key: "status", label: "Email subscription", hideBelow: "lg", render: () => <Badge tone="success">Subscribed</Badge> },
              { key: "source", label: "Signed up from", hideBelow: "lg", render: (r) => <span className="text-muted-foreground">{sourceLabel(r.source)}</span> },
              { key: "date", label: "Subscribed", sortable: true, align: "right", render: (r) => <span className="text-muted-foreground">{dateTime(r.createdAt)}</span> },
            ]}
          />
          {pages > 1 && (
            <div className="flex items-center justify-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span className="tabular-nums">Page {page + 1} of {pages}</span>
              <Button size="sm" variant="outline" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          )}
        </Card>
      )}
      <AddDialog open={adding} onOpenChange={setAdding} />
    </div>
  )
}

function AddDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const add = useMutation(api.subscribers.addManual)
  const [f, setF] = useState({ email: "", name: "", phone: "" })
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setF({ email: "", name: "", phone: "" }) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add subscriber</DialogTitle>
          <DialogDescription>Only add people who agreed to get emails from BlackBole.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Email"><Input autoFocus type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="01XXXXXXXXX" /></Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !f.email.trim()} onClick={async () => {
            setBusy(true)
            try {
              const r = await add({ email: f.email, name: f.name || undefined, phone: f.phone || undefined })
              toast.success(r === "added" ? "Subscriber added" : "Already subscribed — details updated")
              onOpenChange(false); setF({ email: "", name: "", phone: "" })
            } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
          }}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
