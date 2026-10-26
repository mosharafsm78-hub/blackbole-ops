import { useEffect, useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useAction, useMutation, useQuery } from "convex/react"
import {
  AlertTriangle, Archive, ArrowUpDown, ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, FolderMinus, FolderPlus, Globe, ImageOff, Loader2,
  Plus, RefreshCw, Search, Tag,
} from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import {
  Badge, Card, EmptyState, FilterChoices, FilterPill, IndexSearch, IndexTable, IndexTabs, MoreActions, PageHeader, PREVIEW_URL, StatusBadge, TagInput,
  useSelection, useSort, type IndexColumn, type SortDir,
} from "@/components/website-ui"
import { WebsiteTabs } from "@/components/discount-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { dateTime, errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

type Tab = "products" | "collections"
// views (Shopify names): all = every website product, live = Active, hidden = Draft, archived, new = Ops products not on the website
type View = "all" | "live" | "hidden" | "archived" | "new"
const VIEW_KEYS: View[] = ["all", "live", "hidden", "archived", "new"]

export const Route = createFileRoute("/_app/website")({
  validateSearch: (s: Record<string, unknown>) => ({
    tab: (s.tab === "collections" ? "collections" : "products") as Tab,
    view: (VIEW_KEYS.includes(s.view as View) ? s.view : "live") as View,
  }),
  component: () => <WebsiteGuard><WebsitePage /></WebsiteGuard>,
})

// ---------------------------------------------------------------- page
function WebsitePage() {
  const { tab } = Route.useSearch()
  const products = useQuery(api.website.products)
  const colls = useQuery(api.website.collections)
  const [adding, setAdding] = useState(false)
  return (
    <TooltipProvider delayDuration={200}>
    <div className="mx-auto max-w-6xl pb-24">
      <PageHeader
        title={tab === "products" ? "Products" : "Collections"}
        badges={<PublishStatus />}
        subtitle={tab === "products" ? "What shoppers see on blackbole.com. Stock comes live from Ops; saves go live in about a minute." : undefined}
        secondary={<>
          <Button size="sm" variant="outline" asChild><a href={PREVIEW_URL} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> View website</a></Button>
          <SiteActions onAddExisting={() => setAdding(true)} />
        </>}
        primary={tab === "products"
          ? <Button size="sm" asChild><Link to="/website-new">Add product</Link></Button>
          : <Button size="sm" asChild><Link to="/website-collection" search={{ id: "" }}>Create collection</Link></Button>}
      />

      <WebsiteTabs active={tab} />

      {tab === "products" ? <ProductIndex rows={products} collections={colls?.collections ?? []} /> : <CollectionIndex data={colls} />}
      {adding && products && <AddProductDialog rows={products} onClose={() => setAdding(false)} />}
    </div>
    </TooltipProvider>
  )
}

// ---------------------------------------------------------------- publish status
function useTick(ms: number) {
  const [, set] = useState(0)
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(t) }, [ms])
}
export function ago(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return dateTime(t)
}

function PublishStatus() {
  const st = useQuery(api.website.status)
  useTick(15000)
  if (!st) return null
  let tone = "bg-tone-green-bg text-tone-green", dot = "bg-tone-green", label = "Live", tip = "The website shows your latest changes."
  if (!st.hook) { tone = "bg-tone-amber-bg text-tone-amber"; dot = "bg-tone-amber"; label = "Updates off"; tip = "The website update link is missing, so saved changes don't reach the website." }
  else if (st.rebuild?.pending) {
    const left = Math.max(0, Math.ceil((st.rebuild.due - Date.now()) / 60000))
    tone = "bg-tone-blue-bg text-tone-blue"; dot = "bg-tone-blue animate-pulse"; label = "Updating website…"
    tip = "Your saved changes go live in about a minute."
  } else if (st.lastBuild && !st.lastBuild.ok) { tone = "bg-tone-red-bg text-tone-red"; dot = "bg-tone-red"; label = "Update failed"; tip = `The live site is unchanged. It tries again with your next save, or use “Retry website update” in the ⋯ menu.` }
  else if (st.lastBuild && Date.now() - st.lastBuild.at < 3 * 60 * 1000) { tone = "bg-tone-blue-bg text-tone-blue"; dot = "bg-tone-blue animate-pulse"; label = "Updating website…"; tip = "The website is rebuilding with your changes. Takes about a minute." }
  else if (st.lastBuild) tip = `Last published ${ago(st.lastBuild.at)}.`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex cursor-default items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold", tone)}><span className={cn("size-1.5 rounded-full", dot)} />{label}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{tip}</TooltipContent>
    </Tooltip>
  )
}

function SiteActions({ onAddExisting }: { onAddExisting: () => void }) {
  const importCatalog = useAction(api.website.importCatalog)
  const rebuild = useMutation(api.website.rebuildNow)
  const st = useQuery(api.website.status)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="sm" variant="outline">More actions <ChevronDown className="size-3.5" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {st?.lastBuild && !st.lastBuild.ok && <DropdownMenuItem onClick={async () => {
            try { await rebuild({}); toast.success("Trying the website update again") } catch (e) { toast.error(errMsg(e)) }
          }}><RefreshCw className="size-4" /> Retry website update</DropdownMenuItem>}
          <DropdownMenuItem onClick={onAddExisting}><Plus className="size-4" /> Put an existing Ops product on the website</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setConfirm(true)}><Download className="size-4" /> Import from current website</DropdownMenuItem>
          {st?.lastImport && <><DropdownMenuSeparator /><DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Last import {dateTime(st.lastImport.at)}</DropdownMenuLabel></>}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirm} onOpenChange={(o) => !busy && setConfirm(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import from the current website</DialogTitle>
            <DialogDescription>
              Copies every product and collection from the website into Ops and links them by SKU. Website text, photos and collections
              are replaced with the website's version. Ops prices and stock don't change. Safe to run again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button>
            <Button disabled={busy} onClick={async () => {
              setBusy(true)
              try {
                const r = await importCatalog({})
                toast.success(`Imported ${r.products} products and ${r.collections} collections`)
                setConfirm(false)
              } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
            }}>{busy && <Loader2 className="size-4 animate-spin" />}{busy ? "Importing" : "Import"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------- products
type Rows = NonNullable<ReturnType<typeof useQuery<typeof api.website.products>>>
type Row = Rows[number]
type CollRow = NonNullable<ReturnType<typeof useQuery<typeof api.website.collections>>>["collections"][number]
type SortKey = "updated" | "title" | "status" | "stock" | "type" | "vendor" | "price"
type StockF = "in" | "out" | "pre"
type StatusF = "active" | "draft" | "archived"
const PAGE = 50

const STATUS_LABEL: Record<Row["status"], string> = { active: "Active", draft: "Draft", archived: "Archived", new: "Not on website" }

const issuesOf = (r: Row) => [
  !r.photos && "No photos",
  !r.hasDescription && "No description",
  r.noSku > 0 && `${r.noSku} size${r.noSku > 1 ? "s" : ""} without SKU`,
  !r.active && "Inactive in Ops — hidden from the website",
  r.published && r.variants === 0 && "No sizes",
].filter(Boolean) as string[]

/** Shopify's status badge: Active (green), Draft (blue), Archived (grey); plus Ops-only states. */
export function ProductStatusBadge({ status, inactive }: { status: Row["status"]; inactive?: boolean }) {
  if (status === "active" && inactive) return <Badge tone="attention">Inactive in Ops</Badge>
  if (status === "new") return <Badge tone="neutral">Not on website</Badge>
  return <StatusBadge on={status === "active"} status={status} />
}

const inView = (r: Row, v: View) =>
  v === "all" ? r.status !== "new"
    : v === "live" ? r.status === "active"
    : v === "hidden" ? r.status === "draft"
    : v === "archived" ? r.status === "archived"
    : r.status === "new" && !r.partOf

const STATUS_ORDER: Record<Row["status"], number> = { active: 0, draft: 1, archived: 2, new: 3 }

function ProductIndex({ rows, collections }: { rows: Rows | null | undefined; collections: CollRow[] }) {
  const { view } = Route.useSearch()
  const navigate = useNavigate({ from: "/website" })
  const [q, setQ] = useState("")
  const [coll, setColl] = useState<string | null>(null)
  const [type, setType] = useState<string | null>(null)
  const [vendor, setVendor] = useState<string | null>(null)
  const [tag, setTag] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusF | null>(null)
  const [stock, setStock] = useState<StockF | null>(null)
  const [attention, setAttention] = useState(false)
  const sort = useSort<SortKey>("updated", "desc")
  const [page, setPage] = useState(0)

  const counts = useMemo(() => {
    const c: Record<View, number> = { all: 0, live: 0, hidden: 0, archived: 0, new: 0 }
    for (const r of rows ?? []) for (const v of VIEW_KEYS) if (inView(r, v)) c[v]++
    return c
  }, [rows])
  const uniq = (pick: (r: Row) => string[]): string[] => [...new Set<string>((rows ?? []).filter((r) => r.setUp).flatMap(pick).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const types = useMemo(() => uniq((r) => [r.type]), [rows]) // eslint-disable-line react-hooks/exhaustive-deps
  const vendors = useMemo(() => uniq((r) => [r.vendor]), [rows]) // eslint-disable-line react-hooks/exhaustive-deps
  const tags = useMemo(() => uniq((r) => r.tags), [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    const out = (rows ?? []).filter((r) =>
      inView(r, view) &&
      (!s || r.title.toLowerCase().includes(s) || r.name.toLowerCase().includes(s) || (r.handle ?? "").includes(s) || r.tags.some((t) => t.toLowerCase() === s) || r.vendor.toLowerCase().includes(s)) &&
      (!coll || r.collections.includes(coll)) &&
      (!type || r.type === type) &&
      (!vendor || r.vendor === vendor) &&
      (!tag || r.tags.includes(tag)) &&
      (!status || r.status === status) &&
      (!stock || (stock === "pre" ? r.preOrder : stock === "in" ? !r.preOrder && r.stock > 0 : !r.preOrder && r.stock === 0)) &&
      (!attention || issuesOf(r).length > 0))
    const by: Record<SortKey, (a: Row, b: Row) => number> = {
      updated: (a, b) => a.updatedAt - b.updatedAt,
      title: (a, b) => a.title.localeCompare(b.title),
      status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
      stock: (a, b) => a.stock - b.stock,
      type: (a, b) => (a.type || "~").localeCompare(b.type || "~"),
      vendor: (a, b) => (a.vendor || "~").localeCompare(b.vendor || "~"),
      price: (a, b) => a.minPrice - b.minPrice,
    }
    const sign = sort.dir === "asc" ? 1 : -1
    return out.sort((a, b) => sign * by[sort.by](a, b) || a.title.localeCompare(b.title))
  }, [rows, view, q, coll, type, vendor, tag, status, stock, attention, sort.by, sort.dir])

  const sel = useSelection(list.map((r) => r._id as string))
  useEffect(() => { setPage(0) }, [view, q, coll, type, vendor, tag, status, stock, attention, sort.by, sort.dir])
  useEffect(() => { sel.clear() }, [view]) // eslint-disable-line react-hooks/exhaustive-deps

  if (rows === undefined) return <Loading />
  if (rows === null) return null

  const pages = Math.max(1, Math.ceil(list.length / PAGE))
  const shown = list.slice(page * PAGE, page * PAGE + PAGE)
  const filtered = !!(q || coll || type || vendor || tag || status || stock || attention)
  const clear = () => { setQ(""); setColl(null); setType(null); setVendor(null); setTag(null); setStatus(null); setStock(null); setAttention(false) }
  const opts = (xs: string[]) => xs.map((x) => ({ value: x, label: x }))

  const columns: IndexColumn<Row>[] = [
    { key: "image", label: <span className="sr-only">Image</span>, className: "w-12 pr-0", render: (r) => <Thumb url={r.image} /> },
    {
      key: "title", label: "Product", sortable: true, className: "max-w-[22rem]",
      render: (r) => {
        const issues = issuesOf(r)
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-semibold group-hover:underline">{r.title}</span>
              {issues.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild><AlertTriangle className="size-3.5 shrink-0 text-tone-amber" /></TooltipTrigger>
                  <TooltipContent>{issues.join(" · ")}</TooltipContent>
                </Tooltip>
              )}
            </div>
            {(r.partOf || r.status === "new") && <div className="truncate text-xs text-muted-foreground">{r.partOf ? `Sizes shown on “${r.partOf}”` : `Ops: ${r.name}`}</div>}
            <div className="mt-0.5 md:hidden"><ProductStatusBadge status={r.status} inactive={!r.active} /></div>
          </div>
        )
      },
    },
    { key: "status", label: "Status", sortable: true, hideBelow: "md", render: (r) => <ProductStatusBadge status={r.status} inactive={!r.active} /> },
    { key: "stock", label: "Inventory", sortable: true, hideBelow: "sm", render: (r) => <Inventory r={r} /> },
    { key: "type", label: "Type", sortable: true, hideBelow: "lg", className: "text-muted-foreground", render: (r) => r.type || "—" },
    { key: "vendor", label: "Vendor", sortable: true, hideBelow: "lg", className: "text-muted-foreground", render: (r) => r.vendor || "—" },
    {
      key: "price", label: "Price", sortable: true, align: "right",
      render: (r) => !r.variants ? "—" : r.preOrder ? (
        <><div>{r.fullMin === r.fullMax ? taka(r.fullMin) : `${taka(r.fullMin)}–${taka(r.fullMax)}`}</div><div className="text-[11px] text-muted-foreground">Book {r.minPrice === r.maxPrice ? taka(r.minPrice) : `${taka(r.minPrice)}–${taka(r.maxPrice)}`}</div></>
      ) : r.minPrice === r.maxPrice ? taka(r.minPrice) : `${taka(r.minPrice)}–${taka(r.maxPrice)}`,
    },
  ]

  return (
    <Card flush>
      <IndexTabs<View>
        tabs={[
          { id: "all", label: "All", count: counts.all },
          { id: "live", label: "Active", count: counts.live },
          { id: "hidden", label: "Draft", count: counts.hidden },
          { id: "archived", label: "Archived", count: counts.archived },
          { id: "new", label: "Not on website", count: counts.new },
        ]}
        value={view}
        onChange={(v) => navigate({ search: (s) => ({ ...s, view: v }) })}
        right={<SortMenu sort={sort} />}
      />
      <IndexSearch value={q} onChange={setQ} placeholder="Search products, vendors or tags"
        pills={<>
          <FilterPill label="Vendor" value={vendor ?? undefined} onClear={() => setVendor(null)}><Choices options={opts(vendors)} value={vendor} onChange={setVendor} /></FilterPill>
          <FilterPill label="Tagged with" value={tag ?? undefined} onClear={() => setTag(null)}><Choices options={opts(tags)} value={tag} onChange={setTag} /></FilterPill>
          <FilterPill label="Status" value={status ? STATUS_LABEL[status] : undefined} onClear={() => setStatus(null)}>
            <FilterChoices<StatusF> options={[{ value: "active", label: "Active" }, { value: "draft", label: "Draft" }, { value: "archived", label: "Archived" }]} value={status} onChange={setStatus} />
          </FilterPill>
          <FilterPill label="Product type" value={type ?? undefined} onClear={() => setType(null)}><Choices options={opts(types)} value={type} onChange={setType} /></FilterPill>
          <FilterPill label="Collection" value={collections.find((c) => c._id === coll)?.title} onClear={() => setColl(null)}>
            <Choices options={collections.map((c) => ({ value: c._id as string, label: c.title }))} value={coll} onChange={setColl} />
          </FilterPill>
          <FilterPill label="Inventory" value={stock ? { in: "In stock", out: "Out of stock", pre: "Pre-order" }[stock] : undefined} onClear={() => setStock(null)}>
            <FilterChoices<StockF> options={[{ value: "in", label: "In stock" }, { value: "out", label: "Out of stock" }, { value: "pre", label: "Pre-order" }]} value={stock} onChange={setStock} />
          </FilterPill>
          <button type="button" onClick={() => setAttention((a) => !a)}
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors", attention ? "bg-tone-amber-bg text-tone-amber" : "border border-dashed border-black/25 text-muted-foreground hover:text-foreground dark:border-white/25")}>
            <AlertTriangle className="size-3.5" /> Needs attention
          </button>
          {filtered && <button type="button" onClick={clear} className="ml-1 text-xs text-tone-blue hover:underline">Clear all</button>}
        </>}
      />
      <IndexTable<Row>
        rows={shown}
        rowId={(r) => r._id as string}
        columns={columns}
        sel={sel}
        sort={{ by: sort.by, dir: sort.dir }}
        onSort={(k) => sort.toggle(k as SortKey)}
        onRowClick={(r) => navigate({ to: "/website-product", search: { id: r._id } })}
        total={list.length}
        bulk={<ProductBulk ids={[...sel.selected] as Id<"products">[]} collections={collections} tags={tags} onDone={sel.clear} />}
        empty={
          <EmptyState icon={<Globe />}
            title={filtered ? "No products found" : view === "new" ? "Every Ops product is on the website" : view === "archived" ? "No archived products" : "Nothing here yet"}
            text={filtered ? "Try changing the filters or search term." : "Use “Add product” to put a product on the website."}
            primary={filtered ? <Button size="sm" variant="outline" onClick={clear}>Clear filters</Button> : undefined} />
        }
      />
      {list.length > PAGE && (
        <div className="flex items-center justify-center gap-3 border-t border-black/[0.08] px-3 py-2 text-xs text-muted-foreground dark:border-white/10">
          <Button size="icon" variant="outline" className="size-7" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>
          <span className="tabular-nums">{page * PAGE + 1}–{Math.min(list.length, (page + 1) * PAGE)} of {list.length}</span>
          <Button size="icon" variant="outline" className="size-7" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button>
        </div>
      )}
    </Card>
  )
}

/** FilterChoices with a scroll limit (vendor, tag, type and collection lists can be long). */
function Choices({ options, value, onChange }: { options: { value: string; label: React.ReactNode }[]; value: string | null; onChange: (v: string | null) => void }) {
  if (!options.length) return <p className="px-2 py-3 text-center text-xs text-muted-foreground">Nothing to pick yet.</p>
  return <div className="max-h-72 overflow-auto"><FilterChoices<string> options={options} value={value} onChange={onChange} /></div>
}

function SortMenu({ sort }: { sort: ReturnType<typeof useSort<SortKey>> }) {
  const items: [SortKey, string][] = [["updated", "Updated"], ["title", "Product title"], ["status", "Status"], ["stock", "Inventory"], ["price", "Price"], ["type", "Product type"], ["vendor", "Vendor"]]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="icon" variant="outline" className="size-7" aria-label="Sort"><ArrowUpDown className="size-3.5" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={sort.by} onValueChange={(v) => sort.set(v as SortKey)}>
          {items.map(([k, l]) => <DropdownMenuRadioItem key={k} value={k}>{l}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={sort.dir} onValueChange={(v) => sort.set(sort.by, v as SortDir)}>
          <DropdownMenuRadioItem value="asc">{sort.by === "updated" ? "Oldest first" : sort.by === "stock" || sort.by === "price" ? "Lowest first" : "A–Z"}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="desc">{sort.by === "updated" ? "Newest first" : sort.by === "stock" || sort.by === "price" ? "Highest first" : "Z–A"}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Shopify's inventory column: "12 in stock for 6 variants". Stock is the sellable stock from Ops. */
function Inventory({ r }: { r: Row }) {
  if (r.preOrder) return <span className="text-tone-blue">Pre-order</span>
  if (!r.variants) return <span className="text-muted-foreground">No variants</span>
  const forN = r.variants > 1 ? ` for ${r.variants} variants` : ""
  if (r.stock <= 0) return <span className="text-tone-red"><span className="tabular-nums">0</span> in stock{forN}</span>
  return <span><span className="tabular-nums">{r.stock}</span> in stock<span className="text-muted-foreground">{forN}</span></span>
}

function Thumb({ url, size = "size-10" }: { url: string | null; size?: string }) {
  return url
    ? <img src={url} alt="" loading="lazy" className={cn(size, "shrink-0 rounded-lg border bg-muted object-cover")} />
    : <div className={cn(size, "flex shrink-0 items-center justify-center rounded-lg border bg-muted text-muted-foreground")}><ImageOff className="size-4" /></div>
}

/** Bulk actions shown in the table header while products are ticked (Shopify: Set as active / draft, More actions). */
function ProductBulk({ ids, collections, tags, onDone }: { ids: Id<"products">[]; collections: CollRow[]; tags: string[]; onDone: () => void }) {
  const setStatus = useMutation(api.website.bulkStatus)
  const toColl = useMutation(api.website.bulkCollection)
  const tagMut = useMutation(api.website.bulkTags)
  const [busy, setBusy] = useState(false)
  const [tagMode, setTagMode] = useState<null | "add" | "remove">(null)
  const [collMode, setCollMode] = useState<null | "add" | "remove">(null)
  const [archiveAsk, setArchiveAsk] = useState(false)
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try { await fn(); toast.success(msg); onDone(); return true } catch (e) { toast.error(errMsg(e)); return false } finally { setBusy(false) }
  }
  const n = ids.length
  const nP = `${n} product${n === 1 ? "" : "s"}`
  return (
    <>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => setStatus({ ids, status: "active" }), `${nP} set as active — live in about a minute`)}>Set as active</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => setStatus({ ids, status: "draft" }), `${nP} set as draft`)}>Set as draft</Button>
      <MoreActions size="icon" label="More bulk actions" actions={[
        { label: "Archive products", icon: <Archive className="size-4" />, onClick: () => setArchiveAsk(true), disabled: busy },
        { label: "Add tags", icon: <Tag className="size-4" />, onClick: () => setTagMode("add"), disabled: busy },
        { label: "Remove tags", icon: <Tag className="size-4" />, onClick: () => setTagMode("remove"), disabled: busy },
        { label: "Add to collection", icon: <FolderPlus className="size-4" />, onClick: () => setCollMode("add"), disabled: busy },
        { label: "Remove from collection", icon: <FolderMinus className="size-4" />, onClick: () => setCollMode("remove"), disabled: busy },
      ]} />
      <Dialog open={archiveAsk} onOpenChange={(o) => !busy && setArchiveAsk(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {nP}?</DialogTitle>
            <DialogDescription>Archived products are hidden from the website and moved to the Archived view. Their Ops sizes, stock and orders are not touched. You can set them as active again any time.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setArchiveAsk(false)}>Cancel</Button>
            <Button disabled={busy} onClick={async () => { if (await run(() => setStatus({ ids, status: "archived" }), `${nP} archived`)) setArchiveAsk(false) }}>Archive products</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {tagMode && <TagsDialog mode={tagMode} count={n} suggestions={tags} busy={busy} onClose={() => setTagMode(null)}
        onApply={async (list) => { if (await run(() => tagMut({ ids, tags: list, add: tagMode === "add" }), tagMode === "add" ? `Tags added to ${nP}` : `Tags removed from ${nP}`)) setTagMode(null) }} />}
      {collMode && <CollectionDialog mode={collMode} count={n} collections={collections} busy={busy} onClose={() => setCollMode(null)}
        onApply={async (c) => { if (await run(() => toColl({ ids, collection: c._id, add: collMode === "add" }), collMode === "add" ? `Added to ${c.title}` : `Removed from ${c.title}`)) setCollMode(null) }} />}
    </>
  )
}

function TagsDialog({ mode, count, suggestions, busy, onClose, onApply }: { mode: "add" | "remove"; count: number; suggestions: string[]; busy: boolean; onClose: () => void; onApply: (tags: string[]) => void }) {
  const [list, setList] = useState<string[]>([])
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add tags" : "Remove tags"}</DialogTitle>
          <DialogDescription>{mode === "add" ? `Add tags to ${count} product${count === 1 ? "" : "s"}.` : `Remove tags from ${count} product${count === 1 ? "" : "s"}.`} Products not on the website are skipped.</DialogDescription>
        </DialogHeader>
        <TagInput value={list} onChange={setList} suggestions={suggestions} placeholder={mode === "add" ? "Search or add tags" : "Search tags"} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !list.length} onClick={() => onApply(list)}>{mode === "add" ? "Add tags" : "Remove tags"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CollectionDialog({ mode, count, collections, busy, onClose, onApply }: { mode: "add" | "remove"; count: number; collections: CollRow[]; busy: boolean; onClose: () => void; onApply: (c: CollRow) => void }) {
  const [q, setQ] = useState("")
  const [pick, setPick] = useState<string | null>(null)
  const s = q.trim().toLowerCase()
  const list = collections.filter((c) => !s || c.title.toLowerCase().includes(s))
  const chosen = collections.find((c) => c._id === pick)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="border-b p-4">
          <DialogTitle>{mode === "add" ? "Add to collection" : "Remove from collection"}</DialogTitle>
          <DialogDescription>{count} product{count === 1 ? "" : "s"} selected.</DialogDescription>
        </DialogHeader>
        <div className="border-b p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search collections" className="border-0 pl-8 shadow-none focus-visible:ring-0" />
          </div>
        </div>
        <div className="max-h-72 overflow-auto p-1">
          {list.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">No collection found.</p>}
          {list.map((c) => (
            <label key={c._id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
              <input type="radio" className="accent-foreground" checked={pick === c._id} onChange={() => setPick(c._id)} />
              <span className="flex-1 truncate">{c.title}</span><span className="text-xs text-muted-foreground">{c.total}</span>
            </label>
          ))}
        </div>
        <DialogFooter className="border-t p-3">
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !chosen} onClick={() => chosen && onApply(chosen)}>{mode === "add" ? "Add" : "Remove"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AddProductDialog({ rows, onClose }: { rows: Rows; onClose: () => void }) {
  const navigate = useNavigate()
  const [q, setQ] = useState("")
  const options = useMemo(() => {
    const s = q.trim().toLowerCase()
    return rows.filter((r) => !r.setUp && !r.partOf && r.active && (!s || r.name.toLowerCase().includes(s))).slice(0, 60)
  }, [rows, q])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b p-4">
          <DialogTitle>Add a product to the website</DialogTitle>
          <DialogDescription>Pick an Ops product. You'll add photos and a description, then switch it on.</DialogDescription>
        </DialogHeader>
        <div className="border-b p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Ops products" className="border-0 pl-8 shadow-none focus-visible:ring-0" />
          </div>
        </div>
        <div className="max-h-96 overflow-auto p-1">
          {options.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{q ? "No Ops product with that name." : "Every active Ops product is already on the website."}</p>}
          {options.map((r) => (
            <button key={r._id} type="button" onClick={() => navigate({ to: "/website-product", search: { id: r._id } })}
              className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent">
              <Thumb url={r.image} size="size-9" />
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{r.name}</div><div className="text-xs text-muted-foreground">{r.variants} size{r.variants === 1 ? "" : "s"} · {r.stock} in stock</div></div>
              <span className="text-sm tabular-nums text-muted-foreground">{r.variants ? taka(r.minPrice) : ""}</span>
            </button>
          ))}
        </div>
        <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">New product with new SKUs? Create it on <Link to="/products" className="underline">Products</Link> first.</div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- collections
function CollectionIndex({ data }: { data: ReturnType<typeof useQuery<typeof api.website.collections>> }) {
  const navigate = useNavigate()
  const [q, setQ] = useState("")
  if (data === undefined) return <Loading />
  if (data === null) return null
  const s = q.trim().toLowerCase()
  const list = data.collections.filter((c) => !s || c.title.toLowerCase().includes(s) || c.handle.includes(s))
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-3 py-2">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search collections" className="h-8 border-0 bg-transparent pl-8 shadow-none focus-visible:ring-0" />
        </div>
      </div>
      {list.length === 0 ? (
        <div className="px-6 py-16 text-center text-sm text-muted-foreground">{q ? "No collection matches." : "No collections yet. Collections group products into pages like “Sandals” or “New arrivals”."}</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr className="border-b"><th className="py-2 pl-4 pr-3 font-medium">Collection</th><th className="py-2 pr-3 font-medium">Products</th><th className="hidden py-2 pr-4 text-right font-medium sm:table-cell">Updated</th></tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c._id} onClick={() => navigate({ to: "/website-collection", search: { id: c._id } })} className="group cursor-pointer border-b last:border-0 hover:bg-muted/40">
                <td className="py-2.5 pl-4 pr-3">
                  <div className="flex items-center gap-3">
                    <Collage image={c.image} thumbs={c.thumbs} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium group-hover:underline">{c.title}</span>
                        {!c.hasDescription && <Tooltip><TooltipTrigger asChild><AlertTriangle className="size-3.5 text-tone-amber" /></TooltipTrigger><TooltipContent>No description (helps Google)</TooltipContent></Tooltip>}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">/collections/{c.handle}</div>
                    </div>
                  </div>
                </td>
                <td className="py-2.5 pr-3 tabular-nums">{c.live} live<span className="text-muted-foreground">{c.total !== c.live ? ` · ${c.total - c.live} hidden` : ""}</span></td>
                <td className="hidden py-2.5 pr-4 text-right text-muted-foreground sm:table-cell">{ago(c.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function Collage({ image, thumbs }: { image: string | null; thumbs: string[] }) {
  if (image) return <Thumb url={image} />
  if (!thumbs.length) return <Thumb url={null} />
  return (
    <div className="grid size-10 shrink-0 grid-cols-2 grid-rows-2 gap-px overflow-hidden rounded-md border bg-border">
      {[0, 1, 2, 3].map((i) => thumbs[i] ? <img key={i} src={thumbs[i]} alt="" loading="lazy" className="size-full object-cover" /> : <div key={i} className="bg-muted" />)}
    </div>
  )
}
