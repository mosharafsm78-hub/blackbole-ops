// Website → product editor, laid out like Shopify's product page: the main column has title, description, media,
// category, pricing, inventory (read-only, stock lives in Ops), shipping, variants and the Google listing; the side
// column has status, publishing, pre-order, organisation and theme template. Saving puts it live (~1 min).
import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import {
  AlertTriangle, ArrowDownUp, Check, ChevronDown, ChevronRight, Copy, ExternalLink, GripVertical, ImagePlus,
  Pencil, Plus, Search, Trash2, X,
} from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import {
  Badge, Field, MediaGrid, PageHeader, PREVIEW_URL, RichText, SaveBar, Section, SeoCard, SITE_URL, SuggestInput, TagInput,
  uploadImages, useDirty, useReorder, type Img,
} from "@/components/website-ui"
import { ProductStatusBadge } from "./website"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/website-product")({
  validateSearch: (s: Record<string, unknown>) => ({ id: String(s.id ?? "") }),
  component: () => <WebsiteGuard><Editor /></WebsiteGuard>,
})

const PRE_TAG = "pre-order"

// Website fields (web.mf) that get their own editors. Everything else is kept as it is.
const K = {
  supplier: "custom.supplier", preDays: "bb26.pre_days", preFee: "bb26.pre_fee", preTitle: "bb26.pre_note_title", preText: "bb26.pre_note_text",
  short: "bb26.short", parts: "bb26.parts", colours: "bb26.colours",
  kicker: "bb26.story_kicker", headline: "bb26.story_headline",
} as const
const STORY = [1, 2, 3].flatMap((n) => [`bb26.story_${n}_title`, `bb26.story_${n}_text`])
const OWN = new Set<string>([...Object.values(K), ...STORY])
/** Fields that only mean something to Shopify (taxonomy, reviews, old SEO): kept untouched, not shown. */
const isShopifyOnly = (k: string) => /^(shopify|reviews|global)\./.test(k) || k === "custom.real_photos"

type Data = NonNullable<ReturnType<typeof useQuery<typeof api.website.product>>>
type Status = "active" | "draft" | "archived"
// price = the website's selling price for this size (blank = use the Ops price); opsPrice = the price in Ops
type Var = {
  id: Id<"variants">; sku: string; title: string; price: string; opsPrice: number; active: boolean; stock: number; compareAt: string
  options: Record<string, string>; image: string | null; cost: string; weight: string; barcode: string
  byLocation: Record<string, { available: number; committed: number }>
}
const eff = (v: Var) => (Number(v.price) > 0 ? Number(v.price) : v.opsPrice)
/** What the shopper finally pays for the pair: the price, or for a pre-order the full price (compare-at, else 2× booking). */
const fullOf = (v: Var, preOrder: boolean) => (preOrder ? (Number(v.compareAt) > eff(v) ? Number(v.compareAt) : eff(v) * 2) : eff(v))
type Form = {
  title: string; handle: string; html: string; type: string; vendor: string; tags: string[]; category: string
  seoTitle: string; seoDesc: string; status: Status; options: string[]; images: Img[]; template: string
  mf: Record<string, string>; vars: Var[]; colls: string[]
}
const digits = (s: string) => s.replace(/[^\d]/g, "")
const decimal = (s: string) => s.replace(/[^\d.]/g, "")
/** The one value every item shares, or null when they differ. */
const same = <T,>(xs: T[]): T | null => (xs.length && xs.every((x) => x === xs[0]) ? xs[0] : null)

function Editor() {
  const { id } = Route.useSearch()
  const data = useQuery(api.website.product, { id: id as Id<"products"> })
  if (data === undefined) return <Loading />
  if (data === null) return <p className="py-16 text-center text-sm text-muted-foreground">Product not found. <Link to="/website" search={{ tab: "products", view: "live" }} className="underline">Back to products</Link></p>
  return <TooltipProvider delayDuration={200}><ProductForm key={data.product._id} data={data} /></TooltipProvider>
}

const categoryText = (c: unknown): string => (typeof c === "string" ? c : c && typeof c === "object" ? String((c as any).fullName ?? (c as any).name ?? "") : "")

function initial(data: Data): Form {
  const p = data.product
  const w: any = p.web ?? {}
  const optNames: string[] = (w.options ?? []).map((o: any) => String(o?.name ?? "")).filter(Boolean)
  const options = optNames.length ? optNames : ["Size"]
  return {
    title: w.title || p.name,
    handle: p.handle,
    html: w.html ?? p.description ?? "",
    type: w.type ?? p.category ?? "",
    vendor: w.vendor ?? "BlackBole",
    tags: Array.isArray(w.tags) ? w.tags.map(String) : [],
    category: categoryText(w.category),
    seoTitle: w.seo?.title ?? "",
    seoDesc: w.seo?.description ?? "",
    status: w.published ? "active" : w.archived ? "archived" : "draft",
    template: typeof w.templateSuffix === "string" ? w.templateSuffix : "",
    options,
    images: (Array.isArray(w.images) && w.images.length ? w.images : p.imageUrl ? [{ url: p.imageUrl, alt: w.title || p.name }] : [])
      .map((i: any) => ({ url: String(i.url), alt: String(i.alt ?? ""), w: i.w ?? null, h: i.h ?? null })),
    mf: Object.fromEntries(Object.entries(w.mf ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])),
    vars: data.variants.map((v) => {
      const o: Record<string, string> = { ...(v.web?.options ?? {}) }
      // a single option with no value yet takes the variant title (e.g. "41" → Size: 41)
      if (options.length === 1 && !o[options[0]]) o[options[0]] = v.title
      return {
        id: v._id, sku: v.sku, title: v.title, price: v.web?.price ? String(v.web.price) : "", opsPrice: v.price, active: v.active, stock: v.stock,
        compareAt: v.web?.compareAt ? String(v.web.compareAt) : "", options: o, image: v.web?.image ?? null,
        cost: String(v.cost ?? 0), weight: String(v.weightKg ?? ""), barcode: String(v.web?.barcode ?? ""), byLocation: v.byLocation ?? {},
      }
    }),
    colls: data.collections.filter((c) => c.member).map((c) => c._id as string),
  }
}

function ProductForm({ data }: { data: Data }) {
  const p = data.product
  const save = useMutation(api.website.saveProduct)
  const uploadUrl = useMutation(api.website.uploadUrl)
  const fileUrl = useMutation(api.website.fileUrl)
  const start = useMemo(() => initial(data), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState<Form>(start)
  const [saved, setSaved] = useState<Form>(start)
  const { dirty, markSaved } = useDirty(f)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const setMf = (k: string, v: string) => setF((x) => { const mf = { ...x.mf }; if (v.trim()) mf[k] = v; else delete mf[k]; return { ...x, mf } })
  const setAllVars = (patch: Partial<Var>) => setF((x) => ({ ...x, vars: x.vars.map((v) => ({ ...v, ...patch })) }))

  const preOrder = f.tags.some((t) => t.toLowerCase() === PRE_TAG)
  const setPreOrder = (on: boolean) => set("tags", on ? [...f.tags.filter((t) => t.toLowerCase() !== PRE_TAG), PRE_TAG] : f.tags.filter((t) => t.toLowerCase() !== PRE_TAG))
  const plainDesc = f.html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
  const categoryLocked = !!data.product.web && typeof (data.product.web as any).category === "object" && (data.product.web as any).category !== null

  async function onSave() {
    if (!f.title.trim()) { toast.error("Add a title first"); return }
    setSaving(true)
    try {
      const before = new Map(saved.vars.map((v) => [v.id as string, v]))
      const handle = await save({
        id: p._id, handle: f.handle, title: f.title, html: f.html, vendor: f.vendor, type: f.type, tags: f.tags,
        seo: { title: f.seoTitle, description: f.seoDesc }, options: f.options.map((o) => o.trim()).filter(Boolean),
        images: f.images.map((i) => ({ url: i.url, alt: i.alt, w: i.w, h: i.h })), mf: f.mf,
        published: f.status === "active", status: f.status, templateSuffix: f.template,
        ...(!categoryLocked && f.category !== saved.category ? { category: f.category.trim() || null } : {}),
        variants: f.vars.map((v) => {
          const b = before.get(v.id as string)
          return {
            id: v.id, price: Number(v.price) > 0 ? Number(v.price) : null, compareAt: v.compareAt.trim() ? Number(v.compareAt) || null : null, options: v.options, image: v.image,
            barcode: v.barcode,
            // Ops fields: only sent when changed here
            ...(b && v.cost !== b.cost && v.cost.trim() !== "" ? { cost: Number(v.cost) || 0 } : {}),
            ...(b && v.weight !== b.weight && Number(v.weight) > 0 ? { weightKg: Number(v.weight) } : {}),
          }
        }),
        collections: f.colls as Id<"webCollections">[],
      })
      const next = { ...f, handle }
      setF(next); setSaved(next); markSaved(next)
      toast.success(f.status === "active" ? "Saved — live on the website in about a minute" : f.status === "archived" ? "Saved — archived, not on the website" : "Saved as draft — not on the website")
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }

  async function onFiles(files: File[]) {
    setUploading(true)
    try {
      const added = await uploadImages(files, () => uploadUrl({}), (a) => fileUrl(a), f.title)
      if (added.length) setF((x) => ({ ...x, images: [...x.images, ...added] }))
    } catch (e) { toast.error(errMsg(e)) } finally { setUploading(false) }
  }

  const live = saved.status === "active" && p.active && !!saved.handle
  return (
    <div className="mx-auto max-w-6xl pb-24">
      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onDiscard={() => setF(saved)} />

      <ProductHeader id={p._id} title={f.title} onWebsite={!!saved.handle} viewUrl={saved.handle ? `${PREVIEW_URL}/products/${saved.handle}` : null}
        badges={<>
          <ProductStatusBadge status={saved.handle ? saved.status : "new"} inactive={!p.active} />
          {preOrder && <Badge tone="info">Pre-order</Badge>}
        </>} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* main column */}
        <div className="min-w-0 space-y-4">
          <Section>
            <div className="space-y-4">
              <Field label="Title"><Input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Harbor Shore Sandal for Men" className="h-10 text-[15px]" /></Field>
              <Field label="Description"><RichText value={f.html} onChange={(v) => set("html", v)} /></Field>
              <Field label="Media" right={f.images.length ? <span className="text-xs text-muted-foreground">{f.images.length} photo{f.images.length > 1 ? "s" : ""}</span> : undefined}>
                <MediaGrid images={f.images} onChange={(v) => set("images", v)} onFiles={onFiles} uploading={uploading} defaultAlt={f.title} />
              </Field>
              <Field label="Category" hint={categoryLocked ? "Category from Shopify, kept as it is." : "Optional. Describes what the product is, e.g. Shoes > Sandals."}>
                <Input value={f.category} disabled={categoryLocked} onChange={(e) => set("category", e.target.value)} placeholder="e.g. Apparel & Accessories > Shoes > Sandals" />
              </Field>
            </div>
          </Section>

          <Pricing f={f} preOrder={preOrder} setAllVars={setAllVars} />

          <InventoryCard f={f} data={data} preOrder={preOrder} setAllVars={setAllVars} />

          <Section title="Shipping">
            <label className="mb-3 flex items-center gap-2 text-sm"><Checkbox checked disabled /> This is a physical product</label>
            <Field label="Weight" hint={f.vars.length > 1 ? "Applies to every variant. Used for courier charges in Ops." : "Used for courier charges in Ops."}>
              <div className="relative w-40">
                <Input inputMode="decimal" value={same(f.vars.map((v) => v.weight)) ?? ""} placeholder={same(f.vars.map((v) => v.weight)) === null && f.vars.length ? "Varies" : "0.5"}
                  onChange={(e) => setAllVars({ weight: decimal(e.target.value) })} className="pr-9" disabled={!f.vars.length} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">kg</span>
              </div>
            </Field>
          </Section>

          <Variants f={f} set={set} preOrder={preOrder} locations={data.locations} />

          <PageContent f={f} setMf={setMf} />

          <SeoCard
            site={SITE_URL} path="products" handle={f.handle} onHandle={(v) => set("handle", v)}
            title={f.seoTitle} onTitle={(v) => set("seoTitle", v)} desc={f.seoDesc} onDesc={(v) => set("seoDesc", v)}
            fallbackTitle={f.title} fallbackDesc={plainDesc}
          />
        </div>

        {/* sidebar */}
        <div className="space-y-4">
          <Section title="Status">
            <StatusSelect value={f.status} onChange={(v) => set("status", v)} />
            {!p.active && <Note>This product is inactive in Ops, so the website hides it. Turn it on in <Link to="/products" className="underline">Products</Link>.</Note>}
            {p.active && f.status === "active" && !f.images.length && <Note>No photos yet: the product will show with a blank image.</Note>}
          </Section>

          <Section title="Publishing">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2"><span className={cn("size-2 rounded-full", live ? "bg-tone-green" : "bg-tone-gray")} />Online Store</span>
              {saved.handle && <a href={`${PREVIEW_URL}/products/${saved.handle}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">View <ExternalLink className="size-3" /></a>}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {f.status === "active" ? "Shown on blackbole.com. Changes go live by themselves about a minute after you save." : f.status === "archived" ? "Archived: not on the website." : "Draft: not on the website until you set it as Active."}
            </p>
          </Section>

          <Section title="Pre-order" action={<Switch checked={preOrder} onCheckedChange={setPreOrder} aria-label="Pre-order" />}
            sub={preOrder ? "Shoppers book online; stock isn't needed." : "Turn on for items made or shipped after the order."}>
            {preOrder ? (
              <div className="space-y-3">
                <Field label="Supplier" hint="Shown as a small badge on the product."><Input value={f.mf[K.supplier] ?? ""} onChange={(e) => setMf(K.supplier, e.target.value)} placeholder="e.g. Doris Chen" /></Field>
                <Field label="Comes from">
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                    {(["china", "bd"] as const).map((o) => {
                      const on = o === "bd" ? !!f.mf[K.preFee] : !f.mf[K.preFee]
                      return (
                        <button key={o} type="button" onClick={() => setMf(K.preFee, o === "bd" ? (f.mf[K.preFee] || "90") : "")}
                          className={cn("rounded-md py-1.5 text-sm font-medium transition-colors", on ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                          {o === "china" ? "China" : "Bangladesh"}
                        </button>
                      )
                    })}
                  </div>
                </Field>
                <PreOrderMoney f={f} bd={!!f.mf[K.preFee]} />
                <Field label="Ready in (days)"><Input value={f.mf[K.preDays] ?? ""} onChange={(e) => setMf(K.preDays, e.target.value)} placeholder="15–20" /></Field>
                <Field label="Note title"><Input value={f.mf[K.preTitle] ?? ""} onChange={(e) => setMf(K.preTitle, e.target.value)} placeholder="Being made right now" /></Field>
                <Field label="Note text"><Textarea rows={3} value={f.mf[K.preText] ?? ""} onChange={(e) => setMf(K.preText, e.target.value)} /></Field>
              </div>
            ) : null}
          </Section>

          <Section title="Product organization">
            <div className="space-y-4">
              <Field label="Type"><SuggestInput value={f.type} onChange={(v) => set("type", v)} suggestions={data.suggest.types} placeholder="e.g. Sandals" /></Field>
              <Field label="Vendor"><SuggestInput value={f.vendor} onChange={(v) => set("vendor", v)} suggestions={data.suggest.vendors} /></Field>
              <Field label="Collections"><CollectionPicker all={data.collections} value={f.colls} onChange={(v) => set("colls", v)} /></Field>
              <Field label="Tags"><TagInput value={f.tags.filter((t) => t.toLowerCase() !== PRE_TAG)} onChange={(v) => set("tags", preOrder ? [...v, PRE_TAG] : v)} suggestions={data.suggest.tags.filter((t) => t.toLowerCase() !== PRE_TAG)} /></Field>
            </div>
          </Section>

          <Section title="Theme template">
            <TemplateSelect value={f.template} options={data.templates} onChange={(v) => set("template", v)} />
          </Section>

          <Section title="Other colours" sub="Shown as colour choices on this product's page.">
            <ColourPicker all={data.siblings} value={parseIds(f.mf[K.colours])} onChange={(ids) => setMf(K.colours, ids.length ? JSON.stringify(ids) : "")} />
          </Section>

          <Section title="In Ops">
            <div className="text-sm">
              <div className="font-medium">{p.name}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{f.vars.length} variant{f.vars.length === 1 ? "" : "s"} · {f.vars.reduce((s, v) => s + v.stock, 0)} in stock</div>
              <Link to="/products" className="mt-2 inline-block text-xs font-medium underline-offset-2 hover:underline">Edit SKUs and stock →</Link>
            </div>
          </Section>

          <Advanced mf={f.mf} setMf={setMf} />
        </div>
      </div>
    </div>
  )
}

export function StatusSelect({ value, onChange, archived = true }: { value: Status; onChange: (v: Status) => void; archived?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Status)} aria-label="Status"
      className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/20">
      <option value="active">Active</option>
      <option value="draft">Draft</option>
      {archived && <option value="archived">Archived</option>}
    </select>
  )
}

export function TemplateSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  const list = [...new Set(["", ...options, ...(value ? [value] : [])])]
  return (
    <>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Theme template" disabled={list.length < 2}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-70">
        {list.map((t) => <option key={t} value={t}>{t ? `product.${t}` : "Default product"}</option>)}
      </select>
      <p className="mt-2 text-xs text-muted-foreground">{list.length < 2 ? "The live theme has one product page layout." : "Page layout from the live theme."}</p>
    </>
  )
}

// ---------------------------------------------------------------- pricing
function Money({ value, onChange, placeholder, className, invalid, title }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; invalid?: boolean; title?: string }) {
  return (
    <div className={cn("relative", className)}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">৳</span>
      <Input inputMode="numeric" value={value} placeholder={placeholder || "0"} title={title} onChange={(e) => onChange(digits(e.target.value))} className={cn("pl-6 tabular-nums", invalid && "border-tone-red")} />
    </div>
  )
}

/** Profit and margin, as Shopify shows them under Cost per item. */
function ProfitLine({ sell, cost }: { sell: number; cost: number | null }) {
  if (cost === null || !(sell > 0)) return <><Field label="Profit"><Input disabled value="—" /></Field><Field label="Margin"><Input disabled value="—" /></Field></>
  const profit = sell - cost
  return (
    <>
      <Field label="Profit"><Input disabled value={taka(profit)} className={cn(profit < 0 && "text-tone-red")} /></Field>
      <Field label="Margin"><Input disabled value={`${Math.round((profit / sell) * 1000) / 10}%`} /></Field>
    </>
  )
}

function Pricing({ f, preOrder, setAllVars }: { f: Form; preOrder: boolean; setAllVars: (p: Partial<Var>) => void }) {
  if (!f.vars.length) return null
  const price = same(f.vars.map((v) => v.price))
  const effAll = same(f.vars.map(eff))
  const cmp = same(f.vars.map((v) => v.compareAt))
  const cost = same(f.vars.map((v) => v.cost))
  const sell = same(f.vars.map((v) => fullOf(v, preOrder)))
  const ops = same(f.vars.map((v) => v.opsPrice))
  const many = f.vars.length > 1
  return (
    <Section title="Pricing" sub={many ? `Changing a value here sets it for all ${f.vars.length} variants. Change one variant in the Variants table.` : undefined}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={preOrder ? "Booking (paid online)" : "Price"} hint={!preOrder && ops !== null && effAll !== null && effAll !== ops ? `Website price. Ops price is ${taka(ops)}.` : !preOrder ? "Leave empty to use the Ops price." : undefined}>
          <Money value={price ?? ""} placeholder={price === null ? "Varies" : String(effAll ?? "")} onChange={(v) => setAllVars({ price: v })} />
        </Field>
        <Field label={preOrder ? "Full price" : "Compare-at price"} hint={preOrder ? "The shopper pays this minus the booking on delivery." : "Shown crossed out. Must be higher than the price."}>
          <Money value={cmp ?? ""} placeholder={cmp === null ? "Varies" : preOrder ? "Required" : "—"} onChange={(v) => setAllVars({ compareAt: v })} />
        </Field>
      </div>
      <div className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-3">
        <Field label="Cost per item" hint="Ops cost. Only staff see it."><Money value={cost ?? ""} placeholder={cost === null ? "Varies" : "0"} onChange={(v) => setAllVars({ cost: v })} /></Field>
        <ProfitLine sell={sell ?? 0} cost={cost !== null && cost !== "" && sell !== null ? Number(cost) : null} />
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------- inventory (read-only: stock is managed in Ops)
function InventoryCard({ f, data, preOrder, setAllVars }: { f: Form; data: Data; preOrder: boolean; setAllVars: (p: Partial<Var>) => void }) {
  const one = f.vars.length === 1 ? f.vars[0] : null
  const rows = data.locations.map((l) => ({
    ...l,
    available: f.vars.reduce((s, v) => s + (v.byLocation[l._id]?.available ?? 0), 0),
    committed: f.vars.reduce((s, v) => s + (v.byLocation[l._id]?.committed ?? 0), 0),
  }))
  return (
    <Section title="Inventory" action={<Button size="sm" variant="ghost" asChild><Link to="/inventory">Manage in Ops <ExternalLink className="size-3.5" /></Link></Button>}>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked disabled /> Track quantity</label>
      <p className="mt-1 text-xs text-muted-foreground">Stock is counted in Ops (Purchases, Stock in, orders). The website reads it live, so it can't be changed here.</p>
      {preOrder && <p className="mt-2 rounded-md bg-tone-blue-bg px-2.5 py-2 text-xs text-tone-blue">Pre-order: shoppers can order even with no stock.</p>}
      {one && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="SKU (Stock Keeping Unit)" hint={<Link to="/products" className="underline-offset-2 hover:underline">Change SKU in Ops →</Link>}>
            <Input value={one.sku.startsWith("WEB-") ? "" : one.sku} placeholder="No SKU" disabled className="font-mono text-xs" />
          </Field>
          <Field label="Barcode (ISBN, UPC, GTIN, etc.)"><Input value={one.barcode} onChange={(e) => setAllVars({ barcode: e.target.value })} /></Field>
        </div>
      )}
      {f.vars.length > 1 && <p className="mt-3 text-xs text-muted-foreground">SKU and barcode are set per variant — open a variant in the Variants table.</p>}
      <div className="-mx-4 mt-4 border-t">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr className="border-b"><th className="py-2 pl-4 pr-3 font-medium">Location</th><th className="py-2 pr-3 text-right font-medium">Committed</th><th className="py-2 pr-4 text-right font-medium">Available</th></tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l._id} className="border-b last:border-0">
                <td className="py-2 pl-4 pr-3">{l.name}{!l.sellable && <span className="ml-1.5 text-xs text-muted-foreground">· not sold online</span>}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{l.committed}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{l.available}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={3} className="px-4 py-3 text-center text-xs text-muted-foreground">No locations in Ops yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

/** What the shopper pays: the website price is the booking money; the full price is the "Full price" column. */
function PreOrderMoney({ f, bd }: { f: Form; bd: boolean }) {
  const v = f.vars.find((x) => x.active) ?? f.vars[0]
  if (!v) return null
  const p = eff(v)
  const full = Number(v.compareAt) > p ? Number(v.compareAt) : p * 2
  const ok = Number(v.compareAt) > p
  return (
    <div className="rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed">
      <div className="mb-1 font-medium text-foreground">How the shopper pays</div>
      {bd ? (
        <p className="text-muted-foreground">Pays the <b className="text-foreground">{taka(p)}</b> booking online (it is the delivery charge, no extra delivery). Pays <b className="text-foreground">{taka(full - p)}</b> in cash on delivery. Full price {taka(full)}.</p>
      ) : (
        <p className="text-muted-foreground">Pays <b className="text-foreground">{taka(p)}</b> booking + delivery online. Pays <b className="text-foreground">{taka(full - p)}</b> in cash on delivery. Full price {taka(full)}.</p>
      )}
      <p className="mt-1.5 text-muted-foreground">Booking money = the “Booking” price ({bd ? "৳90 for Bangladesh" : "৳500 for China"}). Full price = the “Full price”.</p>
      {!ok && <p className="mt-1.5 font-medium text-tone-red">Full price is missing, so the website uses twice the booking. Fill it in under Pricing.</p>}
      {p !== (bd ? 90 : 500) && <p className="mt-1.5 font-medium text-tone-amber">The booking is {taka(p)}, not the usual {bd ? "৳90" : "৳500"}. Check the Booking price.</p>}
    </div>
  )
}

/** Photo shown when this size/colour is picked (e.g. the brown pair for "Brown / 42"). */
function VariantPhoto({ images, value, onChange, size = "size-9" }: { images: Img[]; value: string | null; onChange: (v: string | null) => void; size?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Choose photo" onClick={(e) => e.stopPropagation()} className={cn(size, "flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40 text-muted-foreground hover:border-foreground/30")}>
          {value ? <img src={value} alt="" className="size-full object-cover" /> : <ImagePlus className="size-4" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="mb-2 px-1 text-xs font-medium">Photo for this variant</div>
        {images.length === 0 ? <p className="px-1 py-3 text-xs text-muted-foreground">Add photos under Media first.</p> : (
          <div className="grid grid-cols-4 gap-1.5">
            {images.map((im) => (
              <button key={im.url} type="button" onClick={() => onChange(im.url)} className={cn("overflow-hidden rounded-md border-2", value === im.url ? "border-primary" : "border-transparent hover:border-foreground/20")}>
                <img src={im.url} alt={im.alt} className="aspect-square w-full object-cover" />
              </button>
            ))}
          </div>
        )}
        {value && <Button size="sm" variant="ghost" className="mt-2 w-full" onClick={() => onChange(null)}>No photo (use the main one)</Button>}
      </PopoverContent>
    </Popover>
  )
}

/** Shopify product header: back to Products, title + badges, Duplicate, View, More actions (remove from the website; the Ops product stays). */
function ProductHeader({ id, title, onWebsite, viewUrl, badges }: { id: Id<"products">; title: string; onWebsite: boolean; viewUrl: string | null; badges: React.ReactNode }) {
  const navigate = useNavigate()
  const remove = useMutation(api.website.removeFromWebsite)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <PageHeader
        title={title || "Untitled product"}
        back={{ to: "/website", search: { tab: "products", view: "live" }, label: "Products" }}
        badges={badges}
        secondary={<>
          <Button size="sm" variant="outline" onClick={() => navigate({ to: "/website-new", search: { from: id } })}><Copy className="size-4" /> Duplicate</Button>
          {viewUrl && <Button size="sm" variant="outline" asChild><a href={viewUrl} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> View</a></Button>}
        </>}
        more={[
          { label: "Edit SKUs and stock in Ops", icon: <Pencil className="size-4" />, onClick: () => navigate({ to: "/products" }) },
          ...(onWebsite ? [{ label: "Remove from website", icon: <Trash2 className="size-4" />, destructive: true, onClick: () => setConfirm(true) }] : []),
        ]}
      />
      <Dialog open={confirm} onOpenChange={(o) => !busy && setConfirm(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove “{title}” from the website?</DialogTitle>
            <DialogDescription>Its page and collection places go away. The product, sizes, stock and orders stay in Ops, and you can add it back any time. To only hide it, set its status to Draft or Archived instead.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={async () => {
              setBusy(true)
              try { await remove({ id }); toast.success("Removed from the website"); setConfirm(false); setTimeout(() => navigate({ to: "/website", search: { tab: "products", view: "live" } }), 0) }
              catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
            }}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 flex gap-2 rounded-md bg-tone-amber-bg px-2.5 py-2 text-xs text-tone-amber"><AlertTriangle className="mt-px size-3.5 shrink-0" /><span>{children}</span></p>
}

// ---------------------------------------------------------------- variants
const range = (xs: number[]) => { if (!xs.length) return "—"; const a = Math.min(...xs), b = Math.max(...xs); return a === b ? taka(a) : `${taka(a)} – ${taka(b)}` }

function Variants({ f, set, preOrder, locations }: { f: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void; preOrder: boolean; locations: Data["locations"] }) {
  const { props, drag, over } = useReorder(f.vars, (v) => set("vars", v))
  const [editOpts, setEditOpts] = useState(false)
  const [groupBy, setGroupBy] = useState<string>(f.options.length > 1 ? f.options[0] : "")
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [loc, setLoc] = useState<string>("") // "" = sellable stock (what the website uses)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<number | null>(null)
  const [bulk, setBulk] = useState(false)
  useEffect(() => { if (groupBy && !f.options.includes(groupBy)) setGroupBy(f.options.length > 1 ? f.options[0] : "") }, [f.options, groupBy])

  const setVar = (i: number, patch: Partial<Var>) => set("vars", f.vars.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const setMany = (ids: Set<string>, patch: Partial<Var>) => set("vars", f.vars.map((x) => (ids.has(x.id) ? { ...x, ...patch } : x)))
  const renameOpt = (i: number, name: string) => {
    const old = f.options[i]
    set("options", f.options.map((x, j) => (j === i ? name : x)))
    set("vars", f.vars.map((v) => { const { [old]: val, ...rest } = v.options; return { ...v, options: { ...rest, [name]: val ?? "" } } }))
  }
  const qty = (v: Var) => (loc ? v.byLocation[loc]?.available ?? 0 : v.stock)
  const total = f.vars.reduce((s, v) => s + qty(v), 0)
  const values = (o: string) => [...new Set(f.vars.map((v) => v.options[o]).filter(Boolean))]
  const grouped = !!groupBy && f.options.length > 1
  const groups = useMemo(() => {
    if (!grouped) return []
    const m = new Map<string, number[]>()
    f.vars.forEach((v, i) => { const k = v.options[groupBy] || "—"; m.set(k, [...(m.get(k) ?? []), i]) })
    return [...m.entries()]
  }, [f.vars, groupBy, grouped])
  const allSel = f.vars.length > 0 && f.vars.every((v) => sel.has(v.id))
  const toggle = (ids: string[], on: boolean) => setSel((s) => { const n = new Set(s); for (const id of ids) on ? n.add(id) : n.delete(id); return n })
  const label = (v: Var) => f.options.map((o) => v.options[o]).filter(Boolean).join(" / ") || v.title

  const row = (v: Var, i: number, nested: boolean) => {
    const cmp = Number(v.compareAt)
    const badCmp = preOrder ? !(cmp > eff(v)) : !!v.compareAt && cmp <= eff(v)
    const others = nested ? f.options.filter((o) => o !== groupBy) : f.options
    return (
      <tr key={v.id} {...(grouped ? {} : props(i))} className={cn("border-b last:border-0 hover:bg-muted/30", !v.active && "opacity-50", drag === i && "opacity-40", over === i && drag !== i && "bg-primary/5", sel.has(v.id) && "bg-muted/40")}>
        <td className="w-9 py-1.5 pl-3"><Checkbox checked={sel.has(v.id)} onCheckedChange={(on) => toggle([v.id], !!on)} aria-label={`Select ${label(v)}`} /></td>
        <td className={cn("w-6 text-muted-foreground/60", !grouped && "cursor-grab active:cursor-grabbing")}>{!grouped && <GripVertical className="size-4" />}</td>
        <td className={cn("py-1.5 pr-3", nested && "pl-6")}>
          <div className="flex items-center gap-2.5">
            <VariantPhoto images={f.images} value={v.image} onChange={(image) => setVar(i, { image })} />
            <button type="button" onClick={() => setEditing(i)} className="min-w-0 text-left">
              <div className="truncate font-medium hover:underline">{others.map((o) => v.options[o]).filter(Boolean).join(" / ") || v.title}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">{v.sku.startsWith("WEB-") ? <span className="font-sans text-tone-amber">No SKU</span> : v.sku}</div>
            </button>
          </div>
        </td>
        <td className="py-1.5 pr-3">
          <Money className="ml-auto w-28" value={v.price} placeholder={String(v.opsPrice)} title={preOrder ? "Booking money the shopper pays online" : "Selling price on the website (empty = Ops price)"} onChange={(x) => setVar(i, { price: x })} />
          {Number(v.price) > 0 && Number(v.price) !== v.opsPrice && <div className="mt-0.5 text-right text-[10.5px] text-muted-foreground">Ops {taka(v.opsPrice)}</div>}
        </td>
        <td className="py-1.5 pr-3">
          <Money className="w-28" value={v.compareAt} placeholder={preOrder ? "Required" : "—"} invalid={badCmp}
            title={preOrder ? "Full price of the pair. The shopper pays it minus the booking on delivery." : badCmp ? "Compare-at should be higher than the price" : "Crossed-out price"}
            onChange={(x) => setVar(i, { compareAt: x })} />
        </td>
        <td className={cn("py-1.5 pr-3 text-right tabular-nums", qty(v) <= 0 && "text-muted-foreground")}>{qty(v)}</td>
        <td className="w-10 pr-2"><Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(i)} aria-label={`Edit ${label(v)}`}><Pencil className="size-3.5" /></Button></td>
      </tr>
    )
  }

  return (
    <Section title="Variants" flush
      sub={preOrder ? "Pre-order: Booking is paid online, Full price minus booking on delivery." : `${f.vars.length} variant${f.vars.length === 1 ? "" : "s"} · ${total} available · prices are the website's selling prices`}
      action={<>
        {f.vars.length > 1 && !grouped && <Button size="sm" variant="ghost" title="Sort by size (39, 40, 41…)" onClick={() => {
          const key = (v: Var) => f.options.map((o) => v.options[o] ?? "").join(" ") || v.title
          set("vars", [...f.vars].sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true })))
        }}><ArrowDownUp className="size-3.5" /> Sort sizes</Button>}
      </>}>
      {/* options */}
      <div className="mx-4 mb-3 divide-y rounded-lg border">
        {f.options.map((o, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2.5">
            {editOpts ? (
              <>
                <Input value={o} placeholder={i === 0 ? "Size" : "Colour"} onChange={(e) => renameOpt(i, e.target.value)} className="h-8 max-w-56" aria-label="Option name" />
                {f.options.length > 1 && <Button size="icon" variant="ghost" className="ml-auto size-8" onClick={() => set("options", f.options.filter((_, j) => j !== i))} aria-label="Remove option"><Trash2 className="size-4" /></Button>}
              </>
            ) : (
              <div className="min-w-0">
                <div className="text-sm font-medium">{o || `Option ${i + 1}`}</div>
                <div className="mt-1 flex flex-wrap gap-1">{values(o).map((x) => <span key={x} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">{x}</span>)}{!values(o).length && <span className="text-xs text-muted-foreground">No values yet — type them in each variant below</span>}</div>
              </div>
            )}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Button size="sm" variant="ghost" onClick={() => setEditOpts((x) => !x)}>{editOpts ? <><Check className="size-3.5" /> Done</> : <><Pencil className="size-3.5" /> Edit options</>}</Button>
          {editOpts && f.options.length < 3 && <Button size="sm" variant="outline" onClick={() => set("options", [...f.options, ""])}><Plus className="size-4" /> Add another option (e.g. Colour)</Button>}
          <span className="ml-auto text-xs text-muted-foreground">New sizes (with SKUs) are added in <Link to="/products" className="underline">Ops products</Link>.</span>
        </div>
      </div>

      {f.vars.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">No variants yet. Add sizes on <Link to="/products" className="underline">Products</Link>.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs">
            {f.options.length > 1 && (
              <label className="flex items-center gap-1.5 text-muted-foreground">Group by
                <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="h-7 rounded-md border bg-background px-2 text-xs text-foreground">
                  <option value="">None</option>
                  {f.options.filter(Boolean).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            )}
            <label className="ml-auto flex items-center gap-1.5 text-muted-foreground">Stock at
              <select value={loc} onChange={(e) => setLoc(e.target.value)} className="h-7 max-w-48 rounded-md border bg-background px-2 text-xs text-foreground">
                <option value="">All sellable locations</option>
                {locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
              </select>
            </label>
          </div>
          {sel.size > 0 && (
            <div className="flex items-center gap-2 border-t bg-muted/40 px-4 py-1.5 text-xs">
              <span className="font-medium">{sel.size} selected</span>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setBulk(true)}>Bulk edit</Button>
              <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setSel(new Set())}>Clear</button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-y bg-muted/30">
                  <th className="w-9 py-2 pl-3"><Checkbox checked={allSel ? true : sel.size ? "indeterminate" : false} onCheckedChange={(on) => toggle(f.vars.map((v) => v.id), !!on)} aria-label="Select all variants" /></th>
                  <th className="w-6" />
                  <th className="py-2 pr-3 font-medium">Variant{grouped ? ` · grouped by ${groupBy}` : ""}</th>
                  <th className="py-2 pr-3 text-right font-medium">{preOrder ? "Booking" : "Price"}</th>
                  <th className="py-2 pr-3 font-medium">{preOrder ? "Full price" : "Compare-at"}</th>
                  <th className="py-2 pr-3 text-right font-medium">Available</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {grouped ? groups.map(([g, idx]) => {
                  const vs = idx.map((i) => f.vars[i])
                  const ids = vs.map((v) => v.id as string)
                  const isOpen = open.has(g)
                  const gSel = ids.every((id) => sel.has(id))
                  const groupPrice = same(vs.map((v) => v.price))
                  return (
                    <Fragment key={g}>
                      <tr className="border-b bg-background hover:bg-muted/30">
                        <td className="py-1.5 pl-3"><Checkbox checked={gSel ? true : ids.some((id) => sel.has(id)) ? "indeterminate" : false} onCheckedChange={(on) => toggle(ids, !!on)} aria-label={`Select ${g}`} /></td>
                        <td />
                        <td className="py-1.5 pr-3">
                          <button type="button" onClick={() => setOpen((s) => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n })} className="flex items-center gap-2 text-left">
                            <VariantImageOf vs={vs} />
                            <span><span className="font-medium">{g}</span><span className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-muted-foreground">{vs.length} variant{vs.length === 1 ? "" : "s"}{isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</span></span>
                          </button>
                        </td>
                        <td className="py-1.5 pr-3">
                          <Money className="ml-auto w-28" value={groupPrice ?? ""} placeholder={groupPrice === null ? range(vs.map(eff)) : String(same(vs.map(eff)) ?? "")} title={`Price for every ${g} variant`} onChange={(x) => setMany(new Set(ids), { price: x })} />
                        </td>
                        <td className="py-1.5 pr-3 text-xs text-muted-foreground">{range(vs.map((v) => Number(v.compareAt)).filter((x) => x > 0))}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{vs.reduce((s, v) => s + qty(v), 0)}</td>
                        <td />
                      </tr>
                      {isOpen && idx.map((i) => row(f.vars[i], i, true))}
                    </Fragment>
                  )
                }) : f.vars.map((v, i) => row(v, i, false))}
              </tbody>
            </table>
          </div>
          <div className="border-t px-4 py-2 text-xs text-muted-foreground">Total available {loc ? `at ${locations.find((l) => l._id === loc)?.name ?? "this location"}` : "to sell online"}: <span className="tabular-nums text-foreground">{total}</span></div>
        </>
      )}
      {editing !== null && f.vars[editing] && (
        <VariantDialog v={f.vars[editing]} options={f.options} images={f.images} preOrder={preOrder} locations={locations}
          onClose={() => setEditing(null)} onSave={(patch) => { setVar(editing, patch); setEditing(null) }} />
      )}
      {bulk && <BulkEditDialog count={sel.size} preOrder={preOrder} onClose={() => setBulk(false)} onApply={(patch) => { setMany(sel, patch); setBulk(false) }} />}
    </Section>
  )
}

function VariantImageOf({ vs }: { vs: Var[] }) {
  const img = vs.find((v) => v.image)?.image
  return img ? <img src={img} alt="" className="size-9 shrink-0 rounded-md border object-cover" /> : <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground"><ImagePlus className="size-4" /></div>
}

/** One variant, like Shopify's variant page: options, prices, cost, SKU/barcode, weight, photo and stock per location. */
function VariantDialog({ v, options, images, preOrder, locations, onClose, onSave }: {
  v: Var; options: string[]; images: Img[]; preOrder: boolean; locations: Data["locations"]; onClose: () => void; onSave: (patch: Partial<Var>) => void
}) {
  const [d, setD] = useState<Var>(v)
  const up = (patch: Partial<Var>) => setD((x) => ({ ...x, ...patch }))
  const cmp = Number(d.compareAt)
  const badCmp = preOrder ? !(cmp > eff(d)) : !!d.compareAt && cmp <= eff(d)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{options.map((o) => d.options[o]).filter(Boolean).join(" / ") || d.title}</DialogTitle>
          <DialogDescription>Changes are kept when you press Done, and go live when you save the product.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="flex gap-4">
            <VariantPhoto images={images} value={d.image} onChange={(image) => up({ image })} size="size-20" />
            <div className="grid flex-1 gap-3 sm:grid-cols-2">
              {options.map((o, k) => <Field key={k} label={o || `Option ${k + 1}`}><Input value={d.options[o] ?? ""} onChange={(e) => up({ options: { ...d.options, [o]: e.target.value } })} /></Field>)}
            </div>
          </div>
          <div className="grid gap-3 border-t pt-4 sm:grid-cols-2">
            <Field label={preOrder ? "Booking (paid online)" : "Price"} hint={Number(d.price) > 0 && Number(d.price) !== d.opsPrice ? `Ops price ${taka(d.opsPrice)}` : !preOrder ? "Empty = Ops price" : undefined}>
              <Money value={d.price} placeholder={String(d.opsPrice)} onChange={(x) => up({ price: x })} />
            </Field>
            <Field label={preOrder ? "Full price" : "Compare-at price"}><Money value={d.compareAt} placeholder={preOrder ? "Required" : "—"} invalid={badCmp} onChange={(x) => up({ compareAt: x })} /></Field>
            <Field label="Cost per item"><Money value={d.cost} onChange={(x) => up({ cost: x })} /></Field>
            <div className="grid grid-cols-2 gap-3"><ProfitLine sell={fullOf(d, preOrder)} cost={d.cost.trim() ? Number(d.cost) : null} /></div>
          </div>
          <div className="grid gap-3 border-t pt-4 sm:grid-cols-3">
            <Field label="SKU" hint={<Link to="/products" className="hover:underline">Change in Ops →</Link>}><Input disabled value={d.sku.startsWith("WEB-") ? "" : d.sku} placeholder="No SKU" className="font-mono text-xs" /></Field>
            <Field label="Barcode"><Input value={d.barcode} onChange={(e) => up({ barcode: e.target.value })} /></Field>
            <Field label="Weight (kg)"><Input inputMode="decimal" value={d.weight} onChange={(e) => up({ weight: decimal(e.target.value) })} /></Field>
          </div>
          <div className="border-t pt-4">
            <div className="mb-2 flex items-center justify-between text-[13px] font-medium">Stock (from Ops)<Link to="/inventory" className="text-xs font-normal text-muted-foreground hover:text-foreground">Manage in Ops →</Link></div>
            <table className="w-full text-sm">
              <tbody>
                {locations.map((l) => (
                  <tr key={l._id} className="border-b last:border-0">
                    <td className="py-1.5">{l.name}{!l.sellable && <span className="ml-1.5 text-xs text-muted-foreground">· not sold online</span>}</td>
                    <td className="py-1.5 text-right text-xs text-muted-foreground">{d.byLocation[l._id]?.committed ? `${d.byLocation[l._id].committed} committed` : ""}</td>
                    <td className="w-16 py-1.5 text-right tabular-nums">{d.byLocation[l._id]?.available ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(d)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Shopify's "Bulk edit": set price, compare-at, cost or weight on the selected variants. Empty = leave as it is. */
function BulkEditDialog({ count, preOrder, onClose, onApply }: { count: number; preOrder: boolean; onClose: () => void; onApply: (patch: Partial<Var>) => void }) {
  const [price, setPrice] = useState("")
  const [cmp, setCmp] = useState("")
  const [cost, setCost] = useState("")
  const [weight, setWeight] = useState("")
  const patch: Partial<Var> = { ...(price ? { price } : {}), ...(cmp ? { compareAt: cmp } : {}), ...(cost ? { cost } : {}), ...(Number(weight) > 0 ? { weight } : {}) }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {count} variant{count === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>Fill in only what you want to change. Empty fields stay as they are.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={preOrder ? "Booking" : "Price"}><Money value={price} placeholder="Keep" onChange={setPrice} /></Field>
          <Field label={preOrder ? "Full price" : "Compare-at price"}><Money value={cmp} placeholder="Keep" onChange={setCmp} /></Field>
          <Field label="Cost per item"><Money value={cost} placeholder="Keep" onChange={setCost} /></Field>
          <Field label="Weight (kg)"><Input inputMode="decimal" value={weight} placeholder="Keep" onChange={(e) => setWeight(decimal(e.target.value))} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!Object.keys(patch).length} onClick={() => onApply(patch)}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- product page content (short line, parts, story)
function PageContent({ f, setMf }: { f: Form; setMf: (k: string, v: string) => void }) {
  const parts = (f.mf[K.parts] ?? "").split("\n").filter((l) => l.trim()).map((l) => { const [a, ...b] = l.split("|"); return [a ?? "", b.join("|")] as [string, string] })
  const setParts = (rows: [string, string][]) => setMf(K.parts, rows.filter(([a, b]) => a.trim() || b.trim()).map(([a, b]) => `${a.replace(/\|/g, "/")}|${b}`).join("\n"))
  const hasStory = !!(f.mf[K.kicker] || f.mf[K.headline] || STORY.some((k) => f.mf[k]))
  const [storyOpen, setStoryOpen] = useState(hasStory)
  const [partsDraft, setPartsDraft] = useState<[string, string][]>(parts)
  const emitted = useRef(f.mf[K.parts] ?? "")
  // re-read only when the value changed from outside (e.g. Discard), not while typing
  useEffect(() => { if ((f.mf[K.parts] ?? "") !== emitted.current) { emitted.current = f.mf[K.parts] ?? ""; setPartsDraft(parts) } }, [f.mf[K.parts]]) // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (n: [string, string][]) => {
    setPartsDraft(n)
    const v = n.filter(([a, b]) => a.trim() || b.trim()).map(([a, b]) => `${a.replace(/\|/g, "/")}|${b}`).join("\n")
    emitted.current = v
    setParts(n)
  }
  const updatePart = (i: number, j: 0 | 1, v: string) => { const n = partsDraft.map((r) => [...r] as [string, string]); n[i][j] = v; commit(n) }
  return (
    <Section title="Product page content" sub="Extra blocks on the product page. Leave anything empty to hide it.">
      <div className="space-y-5">
        <Field label="Short line" hint="One or two sentences under the price."><Textarea rows={2} value={f.mf[K.short] ?? ""} onChange={(e) => setMf(K.short, e.target.value)} placeholder="A slide with one wide strap you set once…" /></Field>

        <div className="space-y-2">
          <div className="flex items-center justify-between"><span className="text-[13px] font-medium">Parts & materials</span><span className="text-xs text-muted-foreground">{partsDraft.length || "None"}</span></div>
          {partsDraft.map(([a, b], i) => (
            <div key={i} className="flex gap-2">
              <Input value={a} placeholder="Part (e.g. Outsole)" onChange={(e) => updatePart(i, 0, e.target.value)} className="w-44 shrink-0" />
              <Input value={b} placeholder="What it is and why it matters" onChange={(e) => updatePart(i, 1, e.target.value)} />
              <Button size="icon" variant="ghost" className="shrink-0" aria-label="Remove part" onClick={() => commit(partsDraft.filter((_, j) => j !== i))}><X className="size-4" /></Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => setPartsDraft([...partsDraft, ["", ""]])}><Plus className="size-4" /> Add part</Button>
        </div>

        <div className="rounded-lg border">
          <button type="button" onClick={() => setStoryOpen((o) => !o)} className="flex w-full items-center justify-between px-3 py-2.5 text-left">
            <span><span className="text-[13px] font-medium">Story</span><span className="ml-2 text-xs text-muted-foreground">{hasStory ? "Shown on the page" : "Optional · a headline and up to 3 short blocks"}</span></span>
            <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", storyOpen && "rotate-180")} />
          </button>
          {storyOpen && (
            <div className="space-y-3 border-t p-3">
              <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                <Field label="Kicker"><Input value={f.mf[K.kicker] ?? ""} onChange={(e) => setMf(K.kicker, e.target.value)} placeholder="Harbor Shore" /></Field>
                <Field label="Headline"><Input value={f.mf[K.headline] ?? ""} onChange={(e) => setMf(K.headline, e.target.value)} placeholder="Our most-worn sandal, and why." /></Field>
              </div>
              {[1, 2, 3].map((n) => (
                <div key={n} className="grid gap-2 sm:grid-cols-[10rem_1fr]">
                  <Input value={f.mf[`bb26.story_${n}_title`] ?? ""} onChange={(e) => setMf(`bb26.story_${n}_title`, e.target.value)} placeholder={`Block ${n} title`} />
                  <Textarea rows={2} value={f.mf[`bb26.story_${n}_text`] ?? ""} onChange={(e) => setMf(`bb26.story_${n}_text`, e.target.value)} placeholder="Text" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------- pickers
export function CollectionPicker({ all, value, onChange }: { all: Data["collections"]; value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState("")
  const chosen = all.filter((c) => value.includes(c._id))
  const list = all.filter((c) => !q.trim() || c.title.toLowerCase().includes(q.trim().toLowerCase()))
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  return (
    <div>
      <Popover onOpenChange={(o) => !o && setQ("")}>
        <PopoverTrigger asChild>
          <button type="button" className="flex h-9 w-full items-center justify-between rounded-md border bg-background px-3 text-left text-sm text-muted-foreground hover:bg-muted/30">
            {value.length ? `${value.length} selected` : "Choose collections"}<ChevronDown className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[--radix-popover-trigger-width] min-w-64 p-0">
          <div className="relative border-b">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search collections" className="h-9 w-full bg-transparent pl-8 pr-2 text-sm outline-none" />
          </div>
          <div className="max-h-64 overflow-auto p-1">
            {list.length === 0 && <p className="px-2 py-4 text-center text-xs text-muted-foreground">No collection found. Create it on Website → Collections.</p>}
            {list.map((c) => (
              <button key={c._id} type="button" onClick={() => toggle(c._id)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent">
                <span className={cn("flex size-4 items-center justify-center rounded border", value.includes(c._id) && "border-primary bg-primary text-primary-foreground")}>{value.includes(c._id) && <Check className="size-3" />}</span>
                <span className="flex-1 truncate">{c.title}</span><span className="text-xs text-muted-foreground">{c.count}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {chosen.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chosen.map((c) => (
            <span key={c._id} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
              {c.title}<button type="button" aria-label={`Remove from ${c.title}`} onClick={() => toggle(c._id)} className="text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

const parseIds = (s?: string): string[] => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } }

function ColourPicker({ all, value, onChange }: { all: Data["siblings"]; value: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState("")
  const byId = new Map<string, Data["siblings"][number]>(all.map((s) => [s.id, s] as const))
  const s = q.trim().toLowerCase()
  const list = all.filter((x) => !value.includes(x.id) && (!s || x.title.toLowerCase().includes(s))).slice(0, 30)
  return (
    <div className="space-y-2">
      {value.map((id) => {
        const x = byId.get(id)
        return (
          <div key={id} className="flex items-center gap-2 rounded-md border p-1.5 pr-1">
            {x?.image ? <img src={x.image} alt="" className="size-8 rounded object-cover" /> : <div className="size-8 rounded bg-muted" />}
            <span className="min-w-0 flex-1 truncate text-sm">{x?.title ?? <span className="text-muted-foreground">Product not found</span>}</span>
            <Button size="icon" variant="ghost" className="size-7" onClick={() => onChange(value.filter((v) => v !== id))} aria-label="Remove"><X className="size-4" /></Button>
          </div>
        )
      })}
      <Popover onOpenChange={(o) => !o && setQ("")}>
        <PopoverTrigger asChild><Button size="sm" variant="outline" className="w-full"><Plus className="size-4" /> Link a colour</Button></PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <div className="relative border-b">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products" className="h-9 w-full bg-transparent pl-8 pr-2 text-sm outline-none" />
          </div>
          <div className="max-h-72 overflow-auto p-1">
            {list.map((x) => (
              <button key={x.id} type="button" onClick={() => onChange([...value, x.id])} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent">
                {x.image ? <img src={x.image} alt="" className="size-7 rounded object-cover" /> : <div className="size-7 rounded bg-muted" />}
                <span className="min-w-0 flex-1 truncate">{x.title}</span>{!x.published && <span className="text-[10px] text-muted-foreground">Hidden</span>}
              </button>
            ))}
            {list.length === 0 && <p className="px-2 py-4 text-center text-xs text-muted-foreground">No products found.</p>}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

// ---------------------------------------------------------------- advanced
function Advanced({ mf, setMf }: { mf: Record<string, string>; setMf: (k: string, v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [k, setK] = useState("")
  const [v, setV] = useState("")
  const custom = Object.entries(mf).filter(([key]) => !OWN.has(key) && !isShopifyOnly(key))
  const hidden = Object.keys(mf).filter(isShopifyOnly).length
  return (
    <section className="rounded-xl border bg-card">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-4 py-3 text-left">
        <span className="text-sm font-semibold">Advanced</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">{custom.length ? `${custom.length} custom field${custom.length > 1 ? "s" : ""}` : ""}<ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} /></span>
      </button>
      {open && (
        <div className="space-y-3 border-t p-4">
          {custom.map(([key, val]) => (
            <div key={key} className="space-y-1">
              <div className="flex items-center justify-between"><span className="font-mono text-[11px] text-muted-foreground">{key}</span>
                <button type="button" className="text-muted-foreground hover:text-tone-red" aria-label={`Remove ${key}`} onClick={() => setMf(key, "")}><Trash2 className="size-3.5" /></button></div>
              <Textarea rows={/^\s*[[{]/.test(val) || val.length > 60 ? 3 : 1} className={cn("min-h-9", /^\s*[[{]/.test(val) && "font-mono text-xs")} value={val} onChange={(e) => setMf(key, e.target.value)} />
            </div>
          ))}
          <div className="space-y-2 rounded-lg bg-muted/40 p-2.5">
            <Input value={k} onChange={(e) => setK(e.target.value.replace(/\s+/g, "_"))} placeholder="Field key (namespace.key)" className="h-8 bg-background font-mono text-xs" />
            <Input value={v} onChange={(e) => setV(e.target.value)} placeholder="Value" className="h-8 bg-background" />
            <Button size="sm" variant="outline" className="w-full" disabled={!/^[\w-]+\.[\w-]+$/.test(k) || !v.trim()} onClick={() => {
              if (mf[k] !== undefined) { toast.error("That field already exists"); return }
              setMf(k, v); setK(""); setV("")
            }}><Plus className="size-4" /> Add field</Button>
          </div>
          {hidden > 0 && <p className="text-xs text-muted-foreground">{hidden} field{hidden > 1 ? "s" : ""} from Shopify (categories, reviews, old SEO) are kept as they are.</p>}
        </div>
      )}
    </section>
  )
}
