import { useEffect, useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useAction, useMutation, useQuery } from "convex/react"
import {
  AlertTriangle, ArrowUpDown, Check, ChevronLeft, ChevronRight, Download, ExternalLink, FolderPlus, Globe, ImageOff, Loader2,
  MoreHorizontal, Plus, RefreshCw, Search, X,
} from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { PREVIEW_URL, StatusBadge } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { dateTime, errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

type Tab = "products" | "collections"
type View = "live" | "hidden" | "new" | "all"

export const Route = createFileRoute("/_app/website")({
  validateSearch: (s: Record<string, unknown>) => ({
    tab: (s.tab === "collections" ? "collections" : "products") as Tab,
    view: (["live", "hidden", "new", "all"].includes(String(s.view)) ? s.view : "live") as View,
  }),
  component: () => <WebsiteGuard><WebsitePage /></WebsiteGuard>,
})

// ---------------------------------------------------------------- page
function WebsitePage() {
  const { tab } = Route.useSearch()
  const navigate = useNavigate({ from: "/website" })
  const products = useQuery(api.website.products)
  const colls = useQuery(api.website.collections)
  const [adding, setAdding] = useState(false)
  return (
    <TooltipProvider delayDuration={200}>
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">Website</h1>
            <PublishStatus />
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">Everything shoppers see on blackbole.com. Stock comes live from Ops.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" asChild><a href={PREVIEW_URL} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> View website</a></Button>
          {tab === "products"
            ? <Button size="sm" asChild><Link to="/website-new"><Plus className="size-4" /> Add product</Link></Button>
            : <Button size="sm" asChild><Link to="/website-collection" search={{ id: "" }}><Plus className="size-4" /> New collection</Link></Button>}
          <MoreActions onAddExisting={() => setAdding(true)} />
        </div>
      </div>

      <div className="mb-4 flex gap-6 border-b">
        {(["products", "collections"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => navigate({ search: (s) => ({ ...s, tab: t }) })}
            className={cn("-mb-px border-b-2 px-0.5 pb-2.5 text-sm font-medium transition-colors", tab === t ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t === "products" ? "Products" : "Collections"}
            <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
              {t === "products" ? products?.filter((p) => p.published).length ?? "–" : colls?.collections.length ?? "–"}
            </span>
          </button>
        ))}
      </div>

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
  if (!st.hook) { tone = "bg-tone-amber-bg text-tone-amber"; dot = "bg-tone-amber"; label = "Publishing off"; tip = "WEBSITE_DEPLOY_HOOK is not set, so saved changes don't reach the website." }
  else if (st.rebuild?.pending) {
    const left = Math.max(0, Math.ceil((st.rebuild.due - Date.now()) / 60000))
    tone = "bg-tone-blue-bg text-tone-blue"; dot = "bg-tone-blue animate-pulse"; label = left > 0 ? `Publishing in ${left} min` : "Publishing…"
    tip = "Changes are grouped for 2 minutes, then the website rebuilds (about 1 more minute)."
  } else if (st.lastBuild && !st.lastBuild.ok) { tone = "bg-tone-red-bg text-tone-red"; dot = "bg-tone-red"; label = "Last publish failed"; tip = `Cloudflare answered ${st.lastBuild.status || "nothing"}. Try “Publish now”.` }
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

function MoreActions({ onAddExisting }: { onAddExisting: () => void }) {
  const importCatalog = useAction(api.website.importCatalog)
  const rebuild = useMutation(api.website.rebuildNow)
  const st = useQuery(api.website.status)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="icon" variant="outline" className="size-8" aria-label="More actions"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onClick={async () => {
            try { const r = await rebuild({}); toast.success(r.hook ? "Publishing now — live in about a minute" : "Publishing is off (no deploy hook)") } catch (e) { toast.error(errMsg(e)) }
          }}><RefreshCw className="size-4" /> Publish now</DropdownMenuItem>
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
type Sort = "updated" | "title" | "price-asc" | "price-desc" | "stock"
type StockF = "any" | "in" | "out" | "pre"
const PAGE = 50

const issuesOf = (r: Row) => [
  !r.photos && "No photos",
  !r.hasDescription && "No description",
  r.noSku > 0 && `${r.noSku} size${r.noSku > 1 ? "s" : ""} without SKU`,
  !r.active && "Inactive in Ops — hidden from the website",
  r.published && r.variants === 0 && "No sizes",
].filter(Boolean) as string[]

function ProductIndex({ rows, collections }: { rows: Rows | null | undefined; collections: CollRow[] }) {
  const { view } = Route.useSearch()
  const navigate = useNavigate({ from: "/website" })
  const [q, setQ] = useState("")
  const [coll, setColl] = useState<string>("")
  const [type, setType] = useState<string>("")
  const [stock, setStock] = useState<StockF>("any")
  const [attention, setAttention] = useState(false)
  const [sort, setSort] = useState<Sort>("updated")
  const [page, setPage] = useState(0)
  const [sel, setSel] = useState<Set<string>>(new Set())

  const inView = (r: Row, v: View) =>
    v === "all" ? true : v === "live" ? r.published : v === "hidden" ? r.setUp && !r.published : !r.setUp && !r.partOf
  const counts = useMemo(() => {
    const c = { live: 0, hidden: 0, new: 0, all: 0 }
    for (const r of rows ?? []) for (const v of ["live", "hidden", "new", "all"] as View[]) if (inView(r, v)) c[v]++
    return c
  }, [rows])
  const types = useMemo(() => [...new Set<string>((rows ?? []).filter((r) => r.setUp && r.type).map((r) => r.type))].sort(), [rows])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    const out = (rows ?? []).filter((r) =>
      inView(r, view) &&
      (!s || r.title.toLowerCase().includes(s) || r.name.toLowerCase().includes(s) || (r.handle ?? "").includes(s)) &&
      (!coll || r.collections.includes(coll)) &&
      (!type || r.type === type) &&
      (stock === "any" || (stock === "pre" ? r.preOrder : stock === "in" ? !r.preOrder && r.stock > 0 : !r.preOrder && r.stock === 0)) &&
      (!attention || issuesOf(r).length > 0))
    const by: Record<Sort, (a: Row, b: Row) => number> = {
      updated: (a, b) => b.updatedAt - a.updatedAt,
      title: (a, b) => a.title.localeCompare(b.title),
      "price-asc": (a, b) => a.minPrice - b.minPrice,
      "price-desc": (a, b) => b.maxPrice - a.maxPrice,
      stock: (a, b) => b.stock - a.stock,
    }
    return out.sort(by[sort])
  }, [rows, view, q, coll, type, stock, attention, sort])

  useEffect(() => { setPage(0) }, [view, q, coll, type, stock, attention, sort])
  useEffect(() => { setSel(new Set()) }, [view])

  if (rows === undefined) return <Loading />
  if (rows === null) return null

  const pages = Math.max(1, Math.ceil(list.length / PAGE))
  const shown = list.slice(page * PAGE, page * PAGE + PAGE)
  const allSel = shown.length > 0 && shown.every((r) => sel.has(r._id))
  const filtered = !!(q || coll || type || stock !== "any" || attention)
  const clear = () => { setQ(""); setColl(""); setType(""); setStock("any"); setAttention(false) }
  const VIEWS: [View, string][] = [["live", "On website"], ["hidden", "Hidden"], ["new", "Not added yet"], ["all", "All"]]

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border bg-card">
        {/* views */}
        <div className="flex items-center gap-1 overflow-x-auto border-b px-2 py-1.5">
          {VIEWS.map(([v, label]) => (
            <button key={v} type="button" onClick={() => navigate({ search: (s) => ({ ...s, view: v }) })}
              className={cn("whitespace-nowrap rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors", view === v ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>
              {label} <span className="ml-0.5 tabular-nums text-muted-foreground">{counts[v]}</span>
            </button>
          ))}
        </div>

        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products" className="h-8 border-0 bg-transparent pl-8 shadow-none focus-visible:ring-0" />
          </div>
          <FilterChip label="Collection" value={collections.find((c) => c._id === coll)?.title} onClear={() => setColl("")}>
            {(close) => (
              <div className="max-h-72 overflow-auto">
                {collections.map((c) => <PickRow key={c._id} on={coll === c._id} onClick={() => { setColl(c._id); close() }}>{c.title}<span className="ml-auto text-xs text-muted-foreground">{c.total}</span></PickRow>)}
              </div>
            )}
          </FilterChip>
          <FilterChip label="Type" value={type || undefined} onClear={() => setType("")}>
            {(close) => <div className="max-h-72 overflow-auto">{types.map((t) => <PickRow key={t} on={type === t} onClick={() => { setType(t); close() }}>{t}</PickRow>)}</div>}
          </FilterChip>
          <FilterChip label="Stock" value={stock === "any" ? undefined : { in: "In stock", out: "Sold out", pre: "Pre-order" }[stock]} onClear={() => setStock("any")}>
            {(close) => (["in", "out", "pre"] as StockF[]).map((s) => <PickRow key={s} on={stock === s} onClick={() => { setStock(s); close() }}>{{ in: "In stock", out: "Sold out", pre: "Pre-order" }[s as "in"]}</PickRow>)}
          </FilterChip>
          <button type="button" onClick={() => setAttention((a) => !a)}
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors", attention ? "border-tone-amber/40 bg-tone-amber-bg text-tone-amber" : "border-dashed text-muted-foreground hover:text-foreground")}>
            <AlertTriangle className="size-3.5" /> Needs attention
          </button>
          {filtered && <button type="button" onClick={clear} className="text-xs text-muted-foreground hover:text-foreground">Clear all</button>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="ml-auto h-7 text-xs"><ArrowUpDown className="size-3.5" /> Sort</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as Sort)}>
                <DropdownMenuRadioItem value="updated">Recently updated</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="title">Title A–Z</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="price-asc">Price, low to high</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="price-desc">Price, high to low</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="stock">Most stock</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* table */}
        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <Globe className="size-8 text-muted-foreground/60" />
            <div className="font-medium">{filtered ? "No products match" : view === "new" ? "Every Ops product is on the website" : "Nothing here yet"}</div>
            <p className="max-w-sm text-sm text-muted-foreground">{filtered ? "Try another search or clear the filters." : "Use “Add product” to put an Ops product on the website."}</p>
            {filtered && <Button size="sm" variant="outline" onClick={clear}>Clear filters</Button>}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="w-10 py-2 pl-3"><Checkbox checked={allSel} onCheckedChange={(on) => setSel((s) => { const n = new Set(s); for (const r of shown) on ? n.add(r._id) : n.delete(r._id); return n })} aria-label="Select all" /></th>
                  <th className="py-2 pr-3 font-medium">Product</th>
                  <th className="hidden py-2 pr-3 font-medium md:table-cell">Status</th>
                  <th className="hidden py-2 pr-3 font-medium sm:table-cell">Inventory</th>
                  <th className="hidden py-2 pr-3 font-medium lg:table-cell">Type</th>
                  <th className="py-2 pr-4 text-right font-medium">Price</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const issues = issuesOf(r)
                  const on = sel.has(r._id)
                  return (
                    <tr key={r._id} onClick={() => navigate({ to: "/website-product", search: { id: r._id } })}
                      className={cn("group cursor-pointer border-b last:border-0 hover:bg-muted/40", on && "bg-muted/50")}>
                      <td className="py-2.5 pl-3" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={on} onCheckedChange={(v) => setSel((s) => { const n = new Set(s); v ? n.add(r._id) : n.delete(r._id); return n })} aria-label={`Select ${r.title}`} />
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-3">
                          <Thumb url={r.image} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-medium group-hover:underline">{r.title}</span>
                              {issues.length > 0 && (
                                <Tooltip>
                                  <TooltipTrigger asChild><AlertTriangle className="size-3.5 shrink-0 text-tone-amber" /></TooltipTrigger>
                                  <TooltipContent>{issues.join(" · ")}</TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {r.partOf ? `Sizes shown on “${r.partOf}”` : r.handle ? `/products/${r.handle}` : `Ops: ${r.name}`}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="hidden py-2.5 pr-3 md:table-cell">{r.setUp ? <StatusBadge on={r.published && r.active} label={r.published && !r.active ? "Inactive in Ops" : undefined} /> : <StatusBadge on={false} label="Not added" />}</td>
                      <td className="hidden py-2.5 pr-3 sm:table-cell"><Inventory r={r} /></td>
                      <td className="hidden py-2.5 pr-3 text-muted-foreground lg:table-cell">{r.type || "—"}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">
                        {!r.variants ? "—" : r.preOrder ? (
                          <><div>{r.fullMin === r.fullMax ? taka(r.fullMin) : `${taka(r.fullMin)}–${taka(r.fullMax)}`}</div><div className="text-[11px] text-muted-foreground">Book {r.minPrice === r.maxPrice ? taka(r.minPrice) : `${taka(r.minPrice)}–${taka(r.maxPrice)}`}</div></>
                        ) : r.minPrice === r.maxPrice ? taka(r.minPrice) : `${taka(r.minPrice)}–${taka(r.maxPrice)}`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {list.length > PAGE && (
          <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <span>{page * PAGE + 1}–{Math.min(list.length, (page + 1) * PAGE)} of {list.length}</span>
            <div className="flex gap-1">
              <Button size="icon" variant="outline" className="size-7" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>
              <Button size="icon" variant="outline" className="size-7" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button>
            </div>
          </div>
        )}
      </div>
      <BulkBar ids={[...sel] as Id<"products">[]} collections={collections} onDone={() => setSel(new Set())} />
    </div>
  )
}

function Inventory({ r }: { r: Row }) {
  if (r.preOrder) return <span className="text-tone-blue">Pre-order</span>
  if (!r.variants) return <span className="text-muted-foreground">No sizes</span>
  if (r.stock <= 0) return <span className="font-medium text-tone-red">Sold out</span>
  return <span><span className="tabular-nums">{r.stock}</span> in stock <span className="text-muted-foreground">· {r.sizesInStock}/{r.variants} sizes</span></span>
}

function Thumb({ url, size = "size-10" }: { url: string | null; size?: string }) {
  return url
    ? <img src={url} alt="" loading="lazy" className={cn(size, "shrink-0 rounded-md border bg-muted object-cover")} />
    : <div className={cn(size, "flex shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground")}><ImageOff className="size-4" /></div>
}

function FilterChip({ label, value, onClear, children }: { label: string; value?: string; onClear: () => void; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn("inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors", value ? "border-foreground/20 bg-muted text-foreground" : "border-dashed text-muted-foreground hover:text-foreground")}>
          {value ? <>{label}: <span className="max-w-32 truncate">{value}</span><span role="button" tabIndex={0} aria-label={`Clear ${label}`} onClick={(e) => { e.stopPropagation(); onClear() }} className="-mr-1 rounded-full p-0.5 hover:bg-background"><X className="size-3" /></span></> : <><Plus className="size-3" />{label}</>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-1">{children(() => setOpen(false))}</PopoverContent>
    </Popover>
  )
}

function PickRow({ on, onClick, children }: { on?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent">
      <Check className={cn("size-3.5", on ? "opacity-100" : "opacity-0")} />{children}
    </button>
  )
}

function BulkBar({ ids, collections, onDone }: { ids: Id<"products">[]; collections: CollRow[]; onDone: () => void }) {
  const publish = useMutation(api.website.bulkPublish)
  const toColl = useMutation(api.website.bulkCollection)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try { await fn(); toast.success(msg); onDone() } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  const n = ids.length
  return (
    <div className={cn("fixed inset-x-0 bottom-5 z-40 flex justify-center px-4 transition-all duration-200", n ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-4 opacity-0")}>
      <div className="flex flex-wrap items-center gap-1 rounded-xl border bg-neutral-900 p-1.5 pl-3 text-sm text-white shadow-2xl">
        <span className="mr-2 font-medium tabular-nums">{n} selected</span>
        <Button size="sm" variant="ghost" disabled={busy} className="text-white hover:bg-white/10 hover:text-white" onClick={() => run(() => publish({ ids, published: true }), `${n} product${n > 1 ? "s" : ""} will show on the website`)}>Show on website</Button>
        <Button size="sm" variant="ghost" disabled={busy} className="text-white hover:bg-white/10 hover:text-white" onClick={() => run(() => publish({ ids, published: false }), `${n} product${n > 1 ? "s" : ""} will be hidden`)}>Hide</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" disabled={busy} className="text-white hover:bg-white/10 hover:text-white"><FolderPlus className="size-4" /> Collections</Button></DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="center" className="max-h-80 w-64 overflow-auto">
            <DropdownMenuLabel>Add to collection</DropdownMenuLabel>
            {collections.map((c) => <DropdownMenuItem key={c._id} onClick={() => run(() => toColl({ ids, collection: c._id, add: true }), `Added to ${c.title}`)}>{c.title}</DropdownMenuItem>)}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Remove from collection</DropdownMenuLabel>
            {collections.map((c) => <DropdownMenuItem key={c._id} onClick={() => run(() => toColl({ ids, collection: c._id, add: false }), `Removed from ${c.title}`)}>{c.title}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon" variant="ghost" className="size-8 text-white/70 hover:bg-white/10 hover:text-white" onClick={onDone} aria-label="Clear selection"><X className="size-4" /></Button>
      </div>
    </div>
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
