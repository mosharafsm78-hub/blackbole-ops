import { useMemo, useRef, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ArrowDownUp, ArrowLeft, ExternalLink, GripVertical, ImageOff, ImagePlus, Loader2, Plus, Search, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { Field, PREVIEW_URL, RichText, SaveBar, Section, SeoCard, SITE_URL, StatusBadge, uploadImages, useDirty, useReorder } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TooltipProvider } from "@/components/ui/tooltip"
import { errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/website-collection")({
  validateSearch: (s: Record<string, unknown>) => ({ id: String(s.id ?? "") }),
  component: () => <WebsiteGuard><Editor /></WebsiteGuard>,
})

type Data = Extract<NonNullable<ReturnType<typeof useQuery<typeof api.website.collection>>>, { missing: false }>
type Prod = Data["products"][number]
type Form = { title: string; handle: string; html: string; image: string; seoTitle: string; seoDesc: string; items: string[] }

function Editor() {
  const { id } = Route.useSearch()
  const data = useQuery(api.website.collection, id ? { id: id as Id<"webCollections"> } : {})
  if (data === undefined) return <Loading />
  if (data === null) return null
  if (data.missing) return <p className="py-16 text-center text-sm text-muted-foreground">Collection not found. <Link to="/website" search={{ tab: "collections", view: "live" }} className="underline">Back to collections</Link></p>
  return <TooltipProvider delayDuration={200}><CollectionForm key={data.collection?._id ?? "new"} data={data} /></TooltipProvider>
}

function CollectionForm({ data }: { data: Data }) {
  const c = data.collection
  const navigate = useNavigate()
  const save = useMutation(api.website.saveCollection)
  const del = useMutation(api.website.deleteCollection)
  const uploadUrl = useMutation(api.website.uploadUrl)
  const fileUrl = useMutation(api.website.fileUrl)
  const start: Form = useMemo(() => ({
    title: c?.title ?? "", handle: c?.handle ?? "", html: c?.html ?? "", image: c?.image ?? "",
    seoTitle: c?.seo?.title ?? "", seoDesc: c?.seo?.description ?? "", items: c?.productHandles ?? [],
  }), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState<Form>(start)
  const [saved, setSaved] = useState<Form>(start)
  const { dirty, markSaved } = useDirty(f)
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const info = useMemo(() => new Map<string, Prod>(data.products.map((p) => [p.handle, p] as const)), [data.products])
  const plain = f.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  const isNew = !c

  async function onSave() {
    if (!f.title.trim()) { toast.error("Give the collection a name"); return }
    setSaving(true)
    try {
      const id = await save({
        id: c?._id, title: f.title, handle: f.handle || f.title, html: f.html, image: f.image.trim() || null,
        seo: { title: f.seoTitle, description: f.seoDesc }, productHandles: f.items,
      })
      markSaved(f); setSaved(f)
      toast.success("Collection saved — live on the website in about 3 minutes")
      if (isNew) setTimeout(() => navigate({ to: "/website-collection", search: { id }, replace: true }), 0)
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }

  const live = f.items.filter((h) => info.get(h)?.published).length
  return (
    <div className="mx-auto max-w-6xl pb-24">
      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onDiscard={() => setF(saved)} message={isNew ? "New collection" : "Unsaved changes"} />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button size="icon" variant="outline" className="size-8" asChild><Link to="/website" search={{ tab: "collections", view: "live" }} aria-label="Back to collections"><ArrowLeft className="size-4" /></Link></Button>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">{f.title || (isNew ? "New collection" : "Untitled collection")}</h1>
        {c && <Button size="sm" variant="outline" asChild><a href={`${PREVIEW_URL}/collections/${saved.handle}`} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> View</a></Button>}
        <Button size="sm" disabled={(!dirty && !isNew) || saving} onClick={onSave}>{saving ? "Saving" : "Save"}</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="min-w-0 space-y-4">
          <Section>
            <div className="space-y-4">
              <Field label="Name"><Input autoFocus={isNew} value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Summer sandals" className="h-10 text-[15px]" /></Field>
              <Field label="Description" hint="Shown at the top of the collection page. Helps Google too."><RichText value={f.html} onChange={(v) => set("html", v)} minHeight={140} /></Field>
            </div>
          </Section>

          <Products items={f.items} onChange={(v) => set("items", v)} all={data.products} info={info} />

          <SeoCard site={SITE_URL} path="collections" handle={f.handle} onHandle={(v) => set("handle", v)}
            title={f.seoTitle} onTitle={(v) => set("seoTitle", v)} desc={f.seoDesc} onDesc={(v) => set("seoDesc", v)}
            fallbackTitle={f.title} fallbackDesc={plain} />
        </div>

        <div className="space-y-4">
          <Section title="Summary">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-muted-foreground">Products</dt><dd className="text-lg font-semibold tabular-nums">{f.items.length}</dd></div>
              <div><dt className="text-xs text-muted-foreground">On website</dt><dd className="text-lg font-semibold tabular-nums">{live}</dd></div>
            </dl>
            {f.items.length > live && <p className="mt-2 text-xs text-muted-foreground">{f.items.length - live} hidden product{f.items.length - live > 1 ? "s are" : " is"} in this collection but won't show.</p>}
          </Section>

          <Section title="Image" sub="Used on collection tiles. Without one, the first product photo is used.">
            <CollectionImage url={f.image} onChange={(v) => set("image", v)} upload={(files) => uploadImages(files, () => uploadUrl({}), (a) => fileUrl(a), f.title)} />
          </Section>

          {c && (
            <Section>
              <Button variant="ghost" className="w-full justify-start text-tone-red hover:bg-tone-red-bg hover:text-tone-red" onClick={() => setConfirmDel(true)}><Trash2 className="size-4" /> Delete collection</Button>
            </Section>
          )}
        </div>
      </div>

      <Dialog open={confirmDel} onOpenChange={setConfirmDel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{c?.title}”?</DialogTitle>
            <DialogDescription>The collection page disappears from the website. Its products stay on the website and in their other collections.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDel(false)}>Cancel</Button>
            <Button variant="destructive" onClick={async () => {
              try {
                await del({ id: c!._id })
                markSaved(f)
                toast.success("Collection deleted")
                setTimeout(() => navigate({ to: "/website", search: { tab: "collections", view: "live" } }), 0)
              } catch (e) { toast.error(errMsg(e)) }
            }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Products({ items, onChange, all, info }: { items: string[]; onChange: (v: string[]) => void; all: Prod[]; info: Map<string, Prod> }) {
  const { props, drag, over } = useReorder(items, onChange)
  const [q, setQ] = useState("")
  const [filter, setFilter] = useState("")
  const s = q.trim().toLowerCase()
  const addable = all.filter((p) => !items.includes(p.handle) && (!s || p.title.toLowerCase().includes(s))).slice(0, 40)
  const sortBy = (fn: (a: Prod, b: Prod) => number) => onChange([...items].sort((a, b) => {
    const x = info.get(a), y = info.get(b)
    if (!x || !y) return x ? -1 : y ? 1 : 0
    return fn(x, y)
  }))
  const fs = filter.trim().toLowerCase()
  return (
    <Section title="Products" sub={`${items.length} product${items.length === 1 ? "" : "s"} · drag to set the order shoppers see`} flush
      action={items.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost"><ArrowDownUp className="size-3.5" /> Sort</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => sortBy((a, b) => a.title.localeCompare(b.title))}>Title A–Z</DropdownMenuItem>
            <DropdownMenuItem onClick={() => sortBy((a, b) => a.price - b.price)}>Price, low to high</DropdownMenuItem>
            <DropdownMenuItem onClick={() => sortBy((a, b) => b.price - a.price)}>Price, high to low</DropdownMenuItem>
            <DropdownMenuItem onClick={() => sortBy((a, b) => Number(b.preOrder || b.stock > 0) - Number(a.preOrder || a.stock > 0))}>In stock first</DropdownMenuItem>
            <DropdownMenuItem onClick={() => sortBy((a, b) => Number(b.published) - Number(a.published))}>Hidden last</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}>
      <div className="flex gap-2 px-4 pb-3">
        {items.length > 8 && (
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find in this collection" className="h-9 pl-8" />
          </div>
        )}
        <Popover onOpenChange={(o) => !o && setQ("")}>
          <PopoverTrigger asChild><Button variant="outline" className={cn(items.length <= 8 && "w-full")}><Plus className="size-4" /> Add products</Button></PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <div className="relative border-b">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search website products" className="h-10 w-full bg-transparent pl-8 pr-2 text-sm outline-none" />
            </div>
            <div className="max-h-80 overflow-auto p-1">
              {addable.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">No more products to add.</p>}
              {addable.map((p) => (
                <button key={p.handle} type="button" onClick={() => onChange([...items, p.handle])} className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left hover:bg-accent">
                  <Thumb url={p.image} />
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm">{p.title}</span><span className="text-xs text-muted-foreground">{p.published ? "On website" : "Hidden"} · {taka(p.price)}</span></span>
                  <Plus className="size-4 text-muted-foreground" />
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {items.length === 0 ? (
        <div className="border-t px-4 py-10 text-center text-sm text-muted-foreground">No products yet. Use “Add products” to fill this collection.</div>
      ) : (
        <ol className="max-h-[36rem] overflow-auto border-t">
          {items.map((h, i) => {
            const p = info.get(h)
            if (fs && !(p?.title ?? h).toLowerCase().includes(fs)) return null
            return (
              <li key={h} {...(fs ? {} : props(i))}
                className={cn("group flex items-center gap-3 border-b px-3 py-2 last:border-0", !fs && "cursor-grab active:cursor-grabbing", drag === i && "opacity-40", over === i && drag !== i && "bg-primary/5 shadow-[inset_0_2px_0_hsl(var(--primary))]")}>
                <GripVertical className={cn("size-4 shrink-0 text-muted-foreground/50", fs && "invisible")} />
                <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <Thumb url={p?.image ?? null} />
                <div className="min-w-0 flex-1">
                  {p ? <Link to="/website-product" search={{ id: p._id }} className="block truncate text-sm font-medium hover:underline" draggable={false}>{p.title}</Link>
                    : <span className="block truncate text-sm text-tone-red">Missing product ({h})</span>}
                  {p && <span className="text-xs text-muted-foreground">{p.preOrder ? `Pre-order · book ${taka(p.price)}` : `${p.stock > 0 ? `${p.stock} in stock` : "Sold out"} · ${taka(p.price)}`}</span>}
                </div>
                {p && !p.published && <StatusBadge on={false} />}
                <Button size="icon" variant="ghost" className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onChange(items.filter((x) => x !== h))} aria-label="Remove from collection"><X className="size-4" /></Button>
              </li>
            )
          })}
        </ol>
      )}
    </Section>
  )
}

function Thumb({ url }: { url: string | null }) {
  return url ? <img src={url} alt="" loading="lazy" draggable={false} className="size-9 shrink-0 rounded-md border bg-muted object-cover" />
    : <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"><ImageOff className="size-3.5" /></div>
}

function CollectionImage({ url, onChange, upload }: { url: string; onChange: (v: string) => void; upload: (files: File[]) => Promise<{ url: string }[]> }) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const pick = async (files: File[]) => {
    if (!files.length) return
    setBusy(true)
    try { const [img] = await upload(files.slice(0, 1)); if (img) onChange(img.url) } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <div>
      <input ref={ref} type="file" accept="image/*" className="hidden" onChange={(e) => { pick(Array.from(e.target.files ?? [])); e.target.value = "" }} />
      {url ? (
        <div className="group relative overflow-hidden rounded-lg border">
          <img src={url} alt="" className="aspect-[4/3] w-full object-cover" />
          <div className="absolute inset-x-0 bottom-0 flex gap-2 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => ref.current?.click()}>Replace</Button>
            <Button size="sm" variant="secondary" onClick={() => onChange("")}>Remove</Button>
          </div>
        </div>
      ) : (
        <button type="button" disabled={busy} onClick={() => ref.current?.click()}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(Array.from(e.dataTransfer.files).filter((x) => x.type.startsWith("image/"))) }}
          className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed text-sm text-muted-foreground hover:bg-muted/40">
          {busy ? <Loader2 className="size-5 animate-spin" /> : <ImagePlus className="size-5" />}{busy ? "Uploading…" : "Add image"}
          <span className="text-xs">or drop it here</span>
        </button>
      )}
    </div>
  )
}
