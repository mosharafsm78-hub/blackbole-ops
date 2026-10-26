import { useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { AlertTriangle, ImageOff, LayoutGrid, Plus, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { WebsiteTabs } from "@/components/discount-ui"
import { Badge, Card, EmptyState, IndexSearch, IndexTable, IndexTabs, PageHeader, useSelection, useSort, type IndexColumn } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { dateTime, errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

type Show = "all" | "smart" | "manual" | "hidden"

export const Route = createFileRoute("/_app/website-collections")({
  validateSearch: (s: Record<string, unknown>): { show?: Show } =>
    ["smart", "manual", "hidden"].includes(String(s.show)) ? { show: s.show as Show } : {},
  component: () => <WebsiteGuard><TooltipProvider delayDuration={200}><CollectionsPage /></TooltipProvider></WebsiteGuard>,
})

type Row = NonNullable<ReturnType<typeof useQuery<typeof api.websiteCollections.list>>>[number]
type SortKey = "title" | "products" | "updated"

function ago(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return dateTime(t)
}

/** "Product tag is equal to bb-men and Price is less than ৳2,000", or "Manual". */
function conditionLine(c: { automatic: boolean; match: string; conditions: string[] }) {
  if (!c.automatic) return "Manual"
  return c.conditions.join(c.match === "any" ? " or " : " and ")
}

function CollectionsPage() {
  const rows = useQuery(api.websiteCollections.list)
  const show: Show = Route.useSearch().show ?? "all"
  const navigate = useNavigate({ from: "/website-collections" })
  const [q, setQ] = useState("")
  const sort = useSort<SortKey>("title", "asc")

  const counts = useMemo(() => {
    const r = rows ?? []
    return { all: r.length, smart: r.filter((c) => c.automatic).length, manual: r.filter((c) => !c.automatic).length, hidden: r.filter((c) => !c.published).length }
  }, [rows])
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    const out = (rows ?? []).filter((c) =>
      (show === "all" || (show === "smart" ? c.automatic : show === "manual" ? !c.automatic : !c.published)) &&
      (!s || c.title.toLowerCase().includes(s) || c.handle.includes(s) || c.conditions.some((x) => x.toLowerCase().includes(s))))
    const by: Record<SortKey, (a: Row, b: Row) => number> = {
      title: (a, b) => a.title.localeCompare(b.title), products: (a, b) => a.total - b.total, updated: (a, b) => a.updatedAt - b.updatedAt,
    }
    const d = sort.dir === "asc" ? 1 : -1
    return [...out].sort((a, b) => d * by[sort.by](a, b))
  }, [rows, q, show, sort.by, sort.dir])
  const sel = useSelection(list.map((c) => c._id))

  const setPublished = useMutation(api.websiteCollections.setPublished)
  const remove = useMutation(api.websiteCollections.remove)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const ids = [...sel.selected] as Id<"webCollections">[]
  const n = ids.length
  const plural = n > 1 ? "collections" : "collection"
  const names = (rows ?? []).filter((c) => sel.has(c._id)).map((c) => c.title)
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try { await fn(); toast.success(msg); sel.clear() } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }

  const columns: IndexColumn<Row>[] = [
    {
      key: "title", label: "Title", sortable: true, render: (c) => (
        <div className="flex items-center gap-3">
          <Collage image={c.image} thumbs={c.thumbs} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-semibold group-hover:underline">{c.title}</span>
              {!c.published && <Badge>Hidden</Badge>}
              {!c.hasDescription && <Tooltip><TooltipTrigger asChild><AlertTriangle className="size-3.5 shrink-0 text-tone-amber" /></TooltipTrigger><TooltipContent>No description (helps Google)</TooltipContent></Tooltip>}
            </div>
            <div className="truncate text-xs text-muted-foreground">/collections/{c.handle}</div>
            <div className="truncate text-xs text-muted-foreground md:hidden">{conditionLine(c)}</div>
          </div>
        </div>
      ),
    },
    {
      key: "products", label: "Products", sortable: true, align: "right", render: (c) => (
        <>{c.total}{c.total !== c.live && <div className="text-xs text-muted-foreground">{c.total - c.live} hidden</div>}</>
      ),
    },
    {
      key: "conditions", label: "Product conditions", hideBelow: "md", className: "max-w-[24rem]", render: (c) => c.automatic
        ? <div className="flex items-start gap-1.5"><Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><span className="line-clamp-2">{conditionLine(c)}</span></div>
        : <span className="text-muted-foreground">Manual</span>,
    },
    { key: "updated", label: "Updated", sortable: true, align: "right", hideBelow: "lg", render: (c) => <span className="text-muted-foreground">{ago(c.updatedAt)}</span> },
  ]

  const create = <Button size="sm" asChild><Link to="/website-collection" search={{ id: "" }}><Plus className="size-4" /> Create collection</Link></Button>
  return (
    <div className="mx-auto max-w-6xl pb-16">
      <WebsiteTabs active="collections" />
      <PageHeader title="Collections" primary={create} />

      {rows === undefined ? <Loading /> : rows === null ? null : rows.length === 0 ? (
        <Card>
          <EmptyState icon={<LayoutGrid />} title="Group your products into collections"
            text="Pick products by hand, or let a smart collection fill itself, for example every product tagged “bb-men”." primary={create} />
        </Card>
      ) : (
        <Card flush>
          <IndexTabs<Show> value={show} onChange={(k) => navigate({ search: k === "all" ? {} : { show: k }, replace: true })}
            tabs={[{ id: "all", label: "All", count: counts.all }, { id: "smart", label: "Smart", count: counts.smart }, { id: "manual", label: "Manual", count: counts.manual }, { id: "hidden", label: "Hidden", count: counts.hidden }]} />
          <IndexSearch value={q} onChange={setQ} placeholder="Search collections or conditions" />
          <IndexTable rows={list} rowId={(c) => c._id} columns={columns} sel={sel} total={list.length}
            sort={{ by: sort.by, dir: sort.dir }} onSort={(k) => sort.toggle(k as SortKey)}
            onRowClick={(c) => navigate({ to: "/website-collection", search: { id: c._id } })}
            bulk={<>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => setPublished({ ids, published: true }), `${n} ${plural} will show on the website`)}>Show on website</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => setPublished({ ids, published: false }), `${n} ${plural} hidden from the website`)}>Hide</Button>
            </>}
            bulkMore={[{ label: `Delete ${plural}`, destructive: true, onClick: () => setConfirm(true) }]}
            empty={<p className="px-6 py-12 text-center text-[13px] text-muted-foreground">No collection matches.</p>} />
        </Card>
      )}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {n} {plural}?</DialogTitle>
            <DialogDescription>
              {names.slice(0, 5).join(", ")}{names.length > 5 ? ` and ${names.length - 5} more` : ""}. The collection pages disappear from the website.
              Products stay on the website and in their other collections. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={async () => { setConfirm(false); await run(() => remove({ ids }), `${n} ${plural} deleted`) }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Collage({ image, thumbs }: { image: string | null; thumbs: string[] }) {
  const box = "size-10 shrink-0 overflow-hidden rounded-md border bg-muted"
  if (image) return <img src={image} alt="" loading="lazy" className={cn(box, "object-cover")} />
  if (!thumbs.length) return <div className={cn(box, "flex items-center justify-center text-muted-foreground")}><ImageOff className="size-4" /></div>
  return (
    <div className="grid size-10 shrink-0 grid-cols-2 grid-rows-2 gap-px overflow-hidden rounded-md border bg-border">
      {[0, 1, 2, 3].map((i) => thumbs[i] ? <img key={i} src={thumbs[i]} alt="" loading="lazy" className="size-full object-cover" /> : <div key={i} className="bg-muted" />)}
    </div>
  )
}
