import { useEffect, useMemo, useRef, useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { AlertTriangle, ArrowDownUp, ArrowLeft, Check, ChevronDown, ExternalLink, GripVertical, Plus, Search, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import {
  Field, MediaGrid, PREVIEW_URL, RichText, SaveBar, Section, SeoCard, SITE_URL, StatusBadge, SuggestInput, TagInput,
  uploadImages, useDirty, useReorder, type Img,
} from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TooltipProvider } from "@/components/ui/tooltip"
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
type Var = { id: Id<"variants">; sku: string; title: string; price: number; active: boolean; stock: number; compareAt: string; options: Record<string, string> }
type Form = {
  title: string; handle: string; html: string; type: string; vendor: string; tags: string[]
  seoTitle: string; seoDesc: string; published: boolean; options: string[]; images: Img[]
  mf: Record<string, string>; vars: Var[]; colls: string[]
}

function Editor() {
  const { id } = Route.useSearch()
  const data = useQuery(api.website.product, { id: id as Id<"products"> })
  if (data === undefined) return <Loading />
  if (data === null) return <p className="py-16 text-center text-sm text-muted-foreground">Product not found. <Link to="/website" search={{ tab: "products", view: "live" }} className="underline">Back to Website</Link></p>
  return <TooltipProvider delayDuration={200}><ProductForm key={data.product._id} data={data} /></TooltipProvider>
}

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
    seoTitle: w.seo?.title ?? "",
    seoDesc: w.seo?.description ?? "",
    published: !!w.published,
    options,
    images: (Array.isArray(w.images) && w.images.length ? w.images : p.imageUrl ? [{ url: p.imageUrl, alt: w.title || p.name }] : [])
      .map((i: any) => ({ url: String(i.url), alt: String(i.alt ?? ""), w: i.w ?? null, h: i.h ?? null })),
    mf: Object.fromEntries(Object.entries(w.mf ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])),
    vars: data.variants.map((v) => {
      const o: Record<string, string> = { ...(v.web?.options ?? {}) }
      // a single option with no value yet takes the variant title (e.g. "41" → Size: 41)
      if (options.length === 1 && !o[options[0]]) o[options[0]] = v.title
      return { id: v._id, sku: v.sku, title: v.title, price: v.price, active: v.active, stock: v.stock, compareAt: v.web?.compareAt ? String(v.web.compareAt) : "", options: o }
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

  const preOrder = f.tags.some((t) => t.toLowerCase() === PRE_TAG)
  const setPreOrder = (on: boolean) => set("tags", on ? [...f.tags.filter((t) => t.toLowerCase() !== PRE_TAG), PRE_TAG] : f.tags.filter((t) => t.toLowerCase() !== PRE_TAG))
  const plainDesc = f.html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()

  async function onSave() {
    if (!f.title.trim()) { toast.error("Add a title first"); return }
    setSaving(true)
    try {
      const handle = await save({
        id: p._id, handle: f.handle, title: f.title, html: f.html, vendor: f.vendor, type: f.type, tags: f.tags,
        seo: { title: f.seoTitle, description: f.seoDesc }, options: f.options.map((o) => o.trim()).filter(Boolean),
        images: f.images.map((i) => ({ url: i.url, alt: i.alt, w: i.w, h: i.h })), mf: f.mf, published: f.published,
        variants: f.vars.map((v) => ({ id: v.id, compareAt: v.compareAt.trim() ? Number(v.compareAt) || null : null, options: v.options })),
        collections: f.colls as Id<"webCollections">[],
      })
      const next = { ...f, handle }
      setF(next); setSaved(next); markSaved(next)
      toast.success(f.published ? "Saved — live on the website in about 3 minutes" : "Saved")
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }

  async function onFiles(files: File[]) {
    setUploading(true)
    try {
      const added = await uploadImages(files, () => uploadUrl({}), (a) => fileUrl(a), f.title)
      if (added.length) setF((x) => ({ ...x, images: [...x.images, ...added] }))
    } catch (e) { toast.error(errMsg(e)) } finally { setUploading(false) }
  }

  const live = saved.published && p.active && !!saved.handle
  return (
    <div className="mx-auto max-w-6xl pb-24">
      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onDiscard={() => setF(saved)} />

      {/* header */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button size="icon" variant="outline" className="size-8" asChild><Link to="/website" search={{ tab: "products", view: "live" }} aria-label="Back to Website"><ArrowLeft className="size-4" /></Link></Button>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <h1 className="truncate text-xl font-semibold tracking-tight">{f.title || "Untitled product"}</h1>
          <StatusBadge on={live} label={!p.active ? "Inactive in Ops" : undefined} />
          {preOrder && <span className="rounded-full bg-tone-blue-bg px-2 py-0.5 text-[11px] font-semibold text-tone-blue">Pre-order</span>}
        </div>
        {saved.handle && <Button size="sm" variant="outline" asChild><a href={`${PREVIEW_URL}/products/${saved.handle}`} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> View</a></Button>}
        <Button size="sm" disabled={!dirty || saving} onClick={onSave}>{saving ? "Saving" : "Save"}</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
        {/* main column */}
        <div className="min-w-0 space-y-4">
          <Section>
            <div className="space-y-4">
              <Field label="Title"><Input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Harbor Shore Sandal for Men" className="h-10 text-[15px]" /></Field>
              <Field label="Description"><RichText value={f.html} onChange={(v) => set("html", v)} /></Field>
            </div>
          </Section>

          <Section title="Media" sub={!f.images.length ? undefined : `${f.images.length} photo${f.images.length > 1 ? "s" : ""}`}>
            <MediaGrid images={f.images} onChange={(v) => set("images", v)} onFiles={onFiles} uploading={uploading} defaultAlt={f.title} />
          </Section>

          <Variants f={f} set={set} preOrder={preOrder} />

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
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
              {[true, false].map((on) => (
                <button key={String(on)} type="button" onClick={() => set("published", on)}
                  className={cn("rounded-md py-1.5 text-sm font-medium transition-colors", f.published === on ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {on ? "On website" : "Hidden"}
                </button>
              ))}
            </div>
            {!p.active && <Note>This product is inactive in Ops, so the website hides it. Turn it on in <Link to="/products" className="underline">Products</Link>.</Note>}
            {p.active && f.published && !f.images.length && <Note>No photos yet: the product will show with a blank image.</Note>}
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

          <Section title="Organization">
            <div className="space-y-4">
              <Field label="Type"><SuggestInput value={f.type} onChange={(v) => set("type", v)} suggestions={data.suggest.types} placeholder="e.g. Sandals" /></Field>
              <Field label="Brand"><SuggestInput value={f.vendor} onChange={(v) => set("vendor", v)} suggestions={data.suggest.vendors} /></Field>
              <Field label="Collections"><CollectionPicker all={data.collections} value={f.colls} onChange={(v) => set("colls", v)} /></Field>
              <Field label="Tags"><TagInput value={f.tags.filter((t) => t.toLowerCase() !== PRE_TAG)} onChange={(v) => set("tags", preOrder ? [...v, PRE_TAG] : v)} suggestions={data.suggest.tags.filter((t) => t.toLowerCase() !== PRE_TAG)} /></Field>
            </div>
          </Section>

          <Section title="Other colours" sub="Shown as colour choices on this product's page.">
            <ColourPicker all={data.siblings} value={parseIds(f.mf[K.colours])} onChange={(ids) => setMf(K.colours, ids.length ? JSON.stringify(ids) : "")} />
          </Section>

          <Section title="In Ops">
            <div className="text-sm">
              <div className="font-medium">{p.name}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{f.vars.length} size{f.vars.length === 1 ? "" : "s"} · {f.vars.reduce((s, v) => s + v.stock, 0)} in stock</div>
              <Link to="/products" className="mt-2 inline-block text-xs font-medium underline-offset-2 hover:underline">Edit prices, SKUs and stock →</Link>
            </div>
          </Section>

          <Advanced mf={f.mf} setMf={setMf} />
        </div>
      </div>
    </div>
  )
}

/** What the shopper pays: the website price is the booking money; the full price is the "Full price" column. */
function PreOrderMoney({ f, bd }: { f: Form; bd: boolean }) {
  const v = f.vars.find((x) => x.active) ?? f.vars[0]
  if (!v) return null
  const full = Number(v.compareAt) > v.price ? Number(v.compareAt) : v.price * 2
  const ok = Number(v.compareAt) > v.price
  return (
    <div className="rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed">
      <div className="mb-1 font-medium text-foreground">How the shopper pays</div>
      {bd ? (
        <p className="text-muted-foreground">Pays the <b className="text-foreground">{taka(v.price)}</b> booking online (it is the delivery charge, no extra delivery). Pays <b className="text-foreground">{taka(full - v.price)}</b> in cash on delivery. Full price {taka(full)}.</p>
      ) : (
        <p className="text-muted-foreground">Pays <b className="text-foreground">{taka(v.price)}</b> booking + delivery online. Pays <b className="text-foreground">{taka(full - v.price)}</b> in cash on delivery. Full price {taka(full)}.</p>
      )}
      <p className="mt-1.5 text-muted-foreground">Booking money = the price in Ops ({bd ? "৳90 for Bangladesh" : "৳500 for China"}). Full price = the “Full price” column below.</p>
      {!ok && <p className="mt-1.5 font-medium text-tone-red">Full price is missing, so the website uses twice the booking. Fill it in below.</p>}
      {v.price !== (bd ? 90 : 500) && <p className="mt-1.5 font-medium text-tone-amber">The price in Ops is {taka(v.price)}, not the usual {bd ? "৳90" : "৳500"} booking. Check it on Products.</p>}
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 flex gap-2 rounded-md bg-tone-amber-bg px-2.5 py-2 text-xs text-tone-amber"><AlertTriangle className="mt-px size-3.5 shrink-0" /><span>{children}</span></p>
}

// ---------------------------------------------------------------- variants
function Variants({ f, set, preOrder }: { f: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void; preOrder: boolean }) {
  const { props, drag, over } = useReorder(f.vars, (v) => set("vars", v))
  const [editOpts, setEditOpts] = useState(false)
  const setVar = (i: number, patch: Partial<Var>) => set("vars", f.vars.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const renameOpt = (i: number, name: string) => {
    const old = f.options[i]
    set("options", f.options.map((x, j) => (j === i ? name : x)))
    set("vars", f.vars.map((v) => { const { [old]: val, ...rest } = v.options; return { ...v, options: { ...rest, [name]: val ?? "" } } }))
  }
  const total = f.vars.reduce((s, v) => s + v.stock, 0)
  return (
    <Section title="Sizes & prices" flush
      sub={preOrder
        ? `${f.vars.length} variant${f.vars.length === 1 ? "" : "s"} · pre-order: the Ops price is the booking money, the full price is set here`
        : `${f.vars.length} variant${f.vars.length === 1 ? "" : "s"} · ${total} in stock · price and stock come live from Ops`}
      action={<>
        {f.vars.length > 1 && <Button size="sm" variant="ghost" title="Sort by size (39, 40, 41…)" onClick={() => {
          const key = (v: Var) => f.options.map((o) => v.options[o] ?? "").join(" ") || v.title
          set("vars", [...f.vars].sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true })))
        }}><ArrowDownUp className="size-3.5" /> Sort sizes</Button>}
        <Button size="sm" variant="ghost" onClick={() => setEditOpts((o) => !o)}>{editOpts ? "Done" : "Edit options"}</Button>
      </>}>
      {editOpts && (
        <div className="mx-4 mb-3 space-y-2 rounded-lg border bg-muted/30 p-3">
          {f.options.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input value={o} placeholder={i === 0 ? "Size" : "Colour"} onChange={(e) => renameOpt(i, e.target.value)} className="h-8 max-w-56 bg-background" />
              {f.options.length > 1 && <Button size="icon" variant="ghost" className="size-8" onClick={() => set("options", f.options.filter((_, j) => j !== i))} aria-label="Remove option"><Trash2 className="size-4" /></Button>}
            </div>
          ))}
          {f.options.length < 3 && <Button size="sm" variant="outline" onClick={() => set("options", [...f.options, ""])}><Plus className="size-4" /> Add option (e.g. Colour)</Button>}
        </div>
      )}
      {f.vars.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">No sizes yet. Add them on <Link to="/products" className="underline">Products</Link>.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-y bg-muted/30">
                <th className="w-8" />
                {f.options.map((o, i) => <th key={i} className="py-2 pr-3 font-medium">{o || `Option ${i + 1}`}</th>)}
                <th className="py-2 pr-3 font-medium">SKU</th>
                <th className="py-2 pr-3 text-right font-medium">{preOrder ? "Booking" : "Price"}</th>
                <th className="py-2 pr-3 font-medium">{preOrder ? "Full price" : "Compare-at"}</th>
                <th className="py-2 pr-4 text-right font-medium">Stock</th>
              </tr>
            </thead>
            <tbody>
              {f.vars.map((v, i) => {
                const cmp = Number(v.compareAt)
                const badCmp = preOrder ? !(cmp > v.price) : !!v.compareAt && cmp <= v.price
                return (
                  <tr key={v.id} {...props(i)} className={cn("border-b last:border-0", !v.active && "opacity-50", drag === i && "opacity-40", over === i && drag !== i && "bg-primary/5")}>
                    <td className="cursor-grab pl-2 text-muted-foreground/60 active:cursor-grabbing"><GripVertical className="size-4" /></td>
                    {f.options.map((o, k) => (
                      <td key={k} className="py-1.5 pr-3"><Input className="h-8 w-24" value={v.options[o] ?? ""} onChange={(e) => setVar(i, { options: { ...v.options, [o]: e.target.value } })} /></td>
                    ))}
                    <td className="py-1.5 pr-3 font-mono text-xs text-muted-foreground">{v.sku.startsWith("WEB-") ? <span className="font-sans text-tone-amber">No SKU</span> : v.sku}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{taka(v.price)}</td>
                    <td className="py-1.5 pr-3">
                      <div className="relative w-28">
                        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">৳</span>
                        <Input className={cn("h-8 pl-6", badCmp && "border-tone-red")} inputMode="numeric" value={v.compareAt} placeholder={preOrder ? "Required" : "—"}
                          title={preOrder ? "Full price of the pair. The shopper pays it minus the booking on delivery." : badCmp ? "Compare-at should be higher than the price" : "Crossed-out price"}
                          onChange={(e) => setVar(i, { compareAt: e.target.value.replace(/[^\d]/g, "") })} />
                      </div>
                    </td>
                    <td className={cn("py-1.5 pr-4 text-right tabular-nums", v.stock === 0 && "text-muted-foreground")}>{v.stock}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
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
function CollectionPicker({ all, value, onChange }: { all: Data["collections"]; value: string[]; onChange: (v: string[]) => void }) {
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
