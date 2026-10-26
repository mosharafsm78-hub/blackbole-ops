import { useEffect, useMemo, useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ArrowDownUp, Check, ChevronLeft, ChevronRight, ExternalLink, ImageOff } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { WebsiteTabs } from "@/components/discount-ui"
import { Card, FilterChoices, FilterPill, INDEX, IndexSearch, PageHeader } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/website-inventory")({
  validateSearch: (s: Record<string, unknown>): { collection?: string } => (s.collection ? { collection: String(s.collection) } : {}),
  component: () => <WebsiteGuard><TooltipProvider delayDuration={200}><InventoryPage /></TooltipProvider></WebsiteGuard>,
})

type Data = NonNullable<ReturnType<typeof useQuery<typeof api.websiteInventory.list>>>
type Row = Data["rows"][number]
type Stock = "all" | "in" | "low" | "out"
type Web = "all" | "on" | "off"
type Sort = "product" | "sku" | "available-asc" | "available-desc" | "onhand-desc"
const PAGE = 50

const SORTS: [Sort, string][] = [["product", "Product name"], ["sku", "SKU"], ["available-asc", "Available, low to high"], ["available-desc", "Available, high to low"], ["onhand-desc", "On hand, high to low"]]
const REASONS = ["Stock count correction", "Received new stock", "Returned and restocked", "Damaged", "Lost or stolen", "Other"]

function InventoryPage() {
  const search = Route.useSearch()
  const [loc, setLoc] = useState("")
  const data = useQuery(api.websiteInventory.list, loc ? { locationId: loc as Id<"locations"> } : {})
  const [q, setQ] = useState("")
  const [coll, setColl] = useState(search.collection ?? "")
  const [type, setType] = useState("")
  const [stock, setStock] = useState<Stock>("all")
  const [low, setLow] = useState(2)
  const [web, setWeb] = useState<Web>("all")
  const [sort, setSort] = useState<Sort>("product")
  const [page, setPage] = useState(0)

  const rows = useMemo(() => {
    if (!data) return []
    const s = q.trim().toLowerCase()
    const out = data.rows.filter((r) =>
      (!s || r.sku.toLowerCase().includes(s) || `${r.productTitle} ${r.variantTitle} ${r.opsName}`.toLowerCase().includes(s)) &&
      (!coll || r.collections.includes(coll)) &&
      (!type || r.type === type) &&
      (web === "all" || (web === "on" ? r.onWebsite : !r.onWebsite)) &&
      (stock === "all" || (stock === "in" ? r.available > 0 : stock === "out" ? r.available <= 0 : r.available > 0 && r.available <= low)))
    const by: Record<Sort, (a: Row, b: Row) => number> = {
      product: () => 0, // server order: product, then size
      sku: (a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true }),
      "available-asc": (a, b) => a.available - b.available, "available-desc": (a, b) => b.available - a.available,
      "onhand-desc": (a, b) => b.onHand - a.onHand,
    }
    return sort === "product" ? out : [...out].sort(by[sort])
  }, [data, q, coll, type, web, stock, low, sort])
  useEffect(() => setPage(0), [q, coll, type, web, stock, low, sort, loc])
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE)
  const locName = data?.locations.find((l) => l._id === loc)?.name
  const filtered = !!(q || coll || type || stock !== "all" || web !== "all")

  return (
    <div className="mx-auto max-w-6xl pb-16">
      <WebsiteTabs active="inventory" />
      <PageHeader title="Inventory" subtitle="Stock for every size, straight from Ops. It's the same stock as Ops → Inventory, so a change here shows there too."
        secondary={<Button size="sm" variant="outline" asChild><Link to="/inventory"><ExternalLink className="size-4" /> Open Ops inventory</Link></Button>} />

      {data === undefined ? <Loading /> : data === null ? null : (
        <Card flush>
          <div className="flex flex-wrap items-center gap-2 border-b border-black/[0.08] px-3 py-2 dark:border-white/10">
            <select value={loc} onChange={(e) => setLoc(e.target.value)} aria-label="Location" className="h-8 rounded-lg border border-black/15 bg-background px-2 text-[13px] font-medium dark:border-white/15">
              <option value="">All locations</option>
              {data.locations.map((l) => <option key={l._id} value={l._id}>{l.name}{l.courier ? "" : " (not sold online)"}</option>)}
            </select>
            <span className="flex-1" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="sm" variant="ghost"><ArrowDownUp className="size-3.5" /> {SORTS.find(([k]) => k === sort)?.[1]}</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {SORTS.map(([k, l]) => <DropdownMenuItem key={k} onClick={() => setSort(k)}><Check className={cn("size-3.5", sort === k ? "opacity-100" : "opacity-0")} />{l}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <IndexSearch value={q} onChange={setQ} placeholder="Search product, size or SKU" pills={<>
            <Pick label="Collection" value={coll} onChange={setColl} options={data.collections.map((c) => [c._id, c.title] as [string, string])} />
            <Pick label="Product type" value={type} onChange={setType} options={data.types.map((t) => [t, t] as [string, string])} />
            <FilterPill label="Stock" value={stock === "all" ? undefined : stock === "in" ? "In stock" : stock === "out" ? "Out of stock" : `Low (${low} or fewer)`} onClear={() => setStock("all")}>
              <FilterChoices<"in" | "low" | "out"> value={stock === "all" ? null : stock} onChange={(v) => setStock(v ?? "all")}
                options={[{ value: "in", label: "In stock" }, { value: "low", label: "Low stock" }, { value: "out", label: "Out of stock" }]} />
              {stock === "low" && (
                <label className="mt-2 flex items-center gap-2 px-2 text-xs text-muted-foreground">Low means
                  <select value={low} onChange={(e) => setLow(Number(e.target.value))} className="h-7 rounded-md border bg-background px-1 text-xs text-foreground">
                    {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n} or fewer</option>)}
                  </select>
                </label>
              )}
            </FilterPill>
            <Pick label="Website" value={web === "all" ? "" : web} onChange={(v) => setWeb((v || "all") as Web)} options={[["on", "On the website"], ["off", "Not on the website"]]} />
            {filtered && <button type="button" className="text-xs text-tone-blue hover:underline" onClick={() => { setQ(""); setColl(""); setType(""); setStock("all"); setWeb("all") }}>Clear all</button>}
          </>} />
          {!data.canAdjust ? <p className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">You can see stock here. Changing it needs the “Adjust stock” permission in Ops.</p>
            : !loc ? <p className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">Pick a location above to change quantities.</p> : null}

          {rows.length === 0 ? <p className="px-6 py-12 text-center text-[13px] text-muted-foreground">{data.rows.length ? "Nothing matches these filters." : "No products in Ops yet."}</p> : (
            <div className="overflow-x-auto">
              <table className={INDEX.table}>
                <thead>
                  <tr>
                    <th className={cn(INDEX.th, "pl-4")}>Product</th>
                    <th className={cn(INDEX.th, "hidden md:table-cell")}>SKU</th>
                    <Head label="Unavailable" tip="Damaged, wastage or expired pairs. Not for sale." className="hidden sm:table-cell" />
                    <Head label="Committed" tip="Reserved by approved orders that haven't left yet." className="hidden sm:table-cell" />
                    <Head label="Available" tip="Ready to sell. In courier warehouses this is what the website sells." />
                    <Head label="On hand" tip="Everything in the warehouse: unavailable + committed + available. Pairs with the courier are not counted." className="pr-4" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.variantId} className={INDEX.tr}>
                      <td className="py-2 pl-4 pr-3">
                        <div className="flex items-center gap-3">
                          <Thumb url={r.image} />
                          <div className="min-w-0">
                            {r.setUp ? <Link to="/website-product" search={{ id: r.productId }} className="block truncate font-medium hover:underline">{r.productTitle}</Link>
                              : <Link to="/products" className="block truncate font-medium hover:underline">{r.productTitle}</Link>}
                            <div className="flex flex-wrap items-center gap-x-1.5 truncate text-xs text-muted-foreground">
                              <span>{r.variantTitle}</span>
                              <span className="md:hidden">· {r.sku}</span>
                              {!r.onWebsite && <span>· not on website</span>}
                              {r.preOrder && <span>· pre-order</span>}
                              {(r.inTransit > 0 || r.returning > 0) && <span>· {[r.inTransit ? `${r.inTransit} with courier` : "", r.returning ? `${r.returning} returning` : ""].filter(Boolean).join(", ")}</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="hidden py-2 pr-3 font-mono text-xs md:table-cell">{r.sku}</td>
                      <Num n={r.unavailable} className="hidden sm:table-cell" />
                      <Num n={r.committed} className="hidden sm:table-cell" />
                      <td className="py-2 pr-3 text-right">
                        {data.canAdjust && loc ? <EditAvailable row={r} locationId={loc as Id<"locations">} locName={locName ?? ""} />
                          : <span className={cn("tabular-nums", r.available <= 0 && "text-tone-red")}>{r.available}</span>}
                      </td>
                      <Num n={r.onHand} className="pr-4" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > 0 && (
            <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{page * PAGE + 1}–{Math.min(rows.length, page * PAGE + PAGE)} of {rows.length} size{rows.length === 1 ? "" : "s"}{locName ? ` · ${locName}` : " · all locations"}</span>
              <div className="flex items-center gap-1">
                <Button size="icon" variant="outline" className="size-7" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></Button>
                <span className="px-1 tabular-nums">{page + 1} / {pages}</span>
                <Button size="icon" variant="outline" className="size-7" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight className="size-4" /></Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

function Pick({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <FilterPill label={label} value={options.find(([k]) => k === value)?.[1]} onClear={() => onChange("")}>
      <div className="max-h-72 overflow-auto">
        {options.length === 0 ? <p className="px-2 py-3 text-xs text-muted-foreground">Nothing to pick yet.</p>
          : <FilterChoices value={value || null} onChange={(v) => onChange(v ?? "")} options={options.map(([k, l]) => ({ value: k, label: l }))} />}
      </div>
    </FilterPill>
  )
}

function Head({ label, tip, className }: { label: string; tip: string; className?: string }) {
  return (
    <th className={cn(INDEX.th, "text-right", className)}>
      <Tooltip><TooltipTrigger asChild><span className="cursor-help border-b border-dotted border-muted-foreground/50">{label}</span></TooltipTrigger><TooltipContent className="max-w-60">{tip}</TooltipContent></Tooltip>
    </th>
  )
}

function Num({ n, className }: { n: number; className?: string }) {
  return <td className={cn("py-2 pr-3 text-right tabular-nums", n === 0 && "text-muted-foreground", className)}>{n}</td>
}

function Thumb({ url }: { url: string | null }) {
  return url ? <img src={url} alt="" loading="lazy" className="size-9 shrink-0 rounded-md border bg-muted object-cover" />
    : <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"><ImageOff className="size-3.5" /></div>
}

/** Change "Available" at one location through Ops' own stock adjustment (same permission, same movement log). */
function EditAvailable({ row, locationId, locName }: { row: Row; locationId: Id<"locations">; locName: string }) {
  const adjust = useMutation(api.catalog.adjustStock)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState(String(row.available))
  const [reason, setReason] = useState(REASONS[0])
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const next = Number(target)
  const change = Number.isFinite(next) && target.trim() !== "" ? Math.round(next) - row.available : 0
  const reset = () => { setTarget(String(row.available)); setReason(REASONS[0]); setNote("") }
  async function onSave() {
    if (!change) return
    setBusy(true)
    try {
      const why = reason === "Other" ? note.trim() : [reason, note.trim()].filter(Boolean).join(": ")
      if (!why) { toast.error("Write a reason"); return }
      await adjust({ variantId: row.variantId, locationId, bucket: "available", change, note: `${why} (from Website → Inventory)` })
      toast.success(`${row.productTitle} ${row.variantTitle}: available ${row.available} → ${row.available + change} at ${locName}`)
      setOpen(false)
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) reset() }}>
      <PopoverTrigger asChild>
        <button type="button" className={cn("min-w-12 rounded-md border px-2 py-1 text-right tabular-nums hover:border-foreground/40 hover:bg-muted/50", row.available <= 0 && "text-tone-red")} aria-label={`Change available for ${row.productTitle} ${row.variantTitle}`}>
          {row.available}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <div className="text-sm font-medium">{row.productTitle} · {row.variantTitle}<div className="text-xs font-normal text-muted-foreground">Available at {locName}</div></div>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1 text-xs text-muted-foreground">Adjust by
            <Input type="number" value={change ? String(change) : "0"} onChange={(e) => setTarget(String(row.available + (Math.round(Number(e.target.value)) || 0)))} className="h-8" />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">New
            <Input type="number" autoFocus value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onSave() }} className="h-8" />
          </label>
        </div>
        <label className="block space-y-1 text-xs text-muted-foreground">Reason
          <select value={reason} onChange={(e) => setReason(e.target.value)} className="h-8 w-full rounded-md border bg-background px-2 text-sm text-foreground">
            {REASONS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={reason === "Other" ? "Write the reason" : "Note (optional)"} className="h-8" />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" disabled={!change || busy || (reason === "Other" && !note.trim())} onClick={onSave}>{busy ? "Saving" : "Save"}</Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
