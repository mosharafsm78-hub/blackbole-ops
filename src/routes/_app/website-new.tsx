// Website → Add product. Works like Shopify's "Add product": photos are uploaded (dragged in), sizes are built from
// option values, prices/cost/SKU per size, status, collections and SEO — one Save creates everything.
import { useEffect, useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { AlertTriangle, ArrowLeft, Plus, Trash2, Wand2, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { Field, MediaGrid, RichText, SaveBar, Section, SeoCard, SITE_URL, SuggestInput, TagInput, uploadImages, useDirty, type Img } from "@/components/website-ui"
import { CollectionPicker } from "./website-product"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { TooltipProvider } from "@/components/ui/tooltip"
import { errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/website-new")({
  validateSearch: (s: Record<string, unknown>): { from?: string } => (s.from ? { from: String(s.from) } : {}),
  component: () => <WebsiteGuard><TooltipProvider delayDuration={200}><NewProduct /></TooltipProvider></WebsiteGuard>,
})

const BOOKING = { china: 500, bangladesh: 90 } as const
type Opt = { name: string; values: string[] }
type Row = { key: string; title: string; options: Record<string, string>; sku: string; price: string; compareAt: string; cost: string }
type Form = {
  title: string; html: string; images: Img[]; type: string; vendor: string; tags: string[]; colls: string[]
  published: boolean; preOrder: boolean; from: "china" | "bangladesh"; supplier: string; days: string
  price: string; compareAt: string; cost: string; weight: string; skuPrefix: string
  opts: Opt[]; rows: Record<string, Row>; handle: string; seoTitle: string; seoDesc: string
}
const empty: Form = {
  title: "", html: "", images: [], type: "", vendor: "BlackBole", tags: [], colls: [], published: true, preOrder: false, from: "china",
  supplier: "", days: "", price: "", compareAt: "", cost: "", weight: "0.5", skuPrefix: "",
  opts: [{ name: "Size", values: [] }], rows: {}, handle: "", seoTitle: "", seoDesc: "",
}

const num = (s: string) => Math.round(Number(String(s).replace(/[^\d.]/g, "")) || 0)
const code = (s: string, n: number) => s.normalize("NFKD").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map((w) => (/^\d+$/.test(w) ? w : w[0])).join("").toUpperCase().slice(0, n)
const autoPrefix = (title: string) => `BB-${code(title.replace(/^blackbole\s+/i, ""), 5) || "NEW"}`

/** Every combination of the option values (Size × Colour …), in order. */
function combos(opts: Opt[]): Record<string, string>[] {
  const used = opts.filter((o) => o.name.trim() && o.values.length)
  if (!used.length) return []
  return used.reduce<Record<string, string>[]>((acc, o) => acc.flatMap((c) => o.values.map((v) => ({ ...c, [o.name.trim()]: v }))), [{}])
}

function NewProduct() {
  const navigate = useNavigate()
  const create = useMutation(api.website.createProduct)
  const uploadUrl = useMutation(api.website.uploadUrl)
  const fileUrl = useMutation(api.website.fileUrl)
  const colls = useQuery(api.website.collections)
  const products = useQuery(api.website.products)
  const { from } = Route.useSearch()
  const source = useQuery(api.website.product, from ? { id: from as Id<"products"> } : "skip")
  const [f, setF] = useState<Form>(empty)
  // Duplicate: start from another product (everything except SKUs, which are made new)
  useEffect(() => {
    if (!source) return
    const p = source.product, w: any = p.web ?? {}
    const tags: string[] = (w.tags ?? []).map(String)
    const pre = tags.some((t) => t.toLowerCase() === "pre-order") || !!p.preOrder
    const names: string[] = ((w.options ?? []).map((o: any) => String(o?.name ?? "")).filter(Boolean) as string[])
    const optNames = names.length ? names : ["Size"]
    const vs = source.variants.filter((v) => v.active)
    const opts = optNames.map((n, i) => ({ name: n, values: [...new Set<string>(vs.map((v) => String((v.web?.options ?? {})[n] ?? (optNames.length === 1 ? v.title : v.title.split(" / ")[i] ?? ""))).filter(Boolean))] }))
    const rows: Record<string, Row> = {}
    for (const v of vs) {
      const o: Record<string, string> = {}
      optNames.forEach((n, i) => { o[n] = String((v.web?.options ?? {})[n] ?? (optNames.length === 1 ? v.title : v.title.split(" / ")[i] ?? "")) })
      const webPrice = typeof v.web?.price === "number" ? v.web.price : v.price
      const full = pre ? (Number(v.web?.compareAt) > webPrice ? Number(v.web.compareAt) : v.price) : webPrice
      rows[JSON.stringify(o)] = { key: JSON.stringify(o), title: "", options: o, sku: undefined as unknown as string, price: String(full), compareAt: !pre && v.web?.compareAt ? String(v.web.compareAt) : "", cost: "" }
    }
    for (const k of Object.keys(rows)) delete (rows[k] as any).sku
    const mf = w.mf ?? {}
    setF({
      ...empty, title: `Copy of ${w.title || p.name}`, html: w.html ?? "", images: (w.images ?? []).map((i: any) => ({ url: i.url, alt: i.alt ?? "", w: i.w ?? null, h: i.h ?? null })),
      type: w.type ?? "", vendor: w.vendor ?? "BlackBole", tags: tags.filter((t) => t.toLowerCase() !== "pre-order"),
      colls: source.collections.filter((c) => c.member).map((c) => c._id as string), published: false,
      preOrder: pre, from: mf["bb26.pre_fee"] ? "bangladesh" : "china", supplier: String(mf["custom.supplier"] ?? ""), days: String(mf["bb26.pre_days"] ?? ""),
      opts, rows,
    })
  }, [source?.product._id]) // eslint-disable-line react-hooks/exhaustive-deps
  const { dirty, markSaved } = useDirty(f)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))

  const types = useMemo(() => [...new Set<string>((products ?? []).map((p) => p.type).filter(Boolean))].sort(), [products])
  const allColls = useMemo(() => (colls?.collections ?? []).map((c) => ({ _id: c._id, handle: c.handle, title: c.title, count: c.total, member: false })), [colls])

  // the sizes table follows the option values; edits per size are kept by their option combination
  const prefix = f.skuPrefix.trim() || autoPrefix(f.title)
  const variants: Row[] = combos(f.opts).map((o) => {
    const key = JSON.stringify(o)
    const title = Object.values(o).join(" / ")
    const base = f.rows[key]
    const auto = [prefix, ...Object.entries(o).map(([n, v]) => (/^size$/i.test(n) ? v : code(v, 3)))].join("-").toUpperCase().replace(/\s+/g, "")
    return { key, title, options: o, sku: base?.sku || auto, price: base?.price ?? "", compareAt: base?.compareAt ?? "", cost: base?.cost ?? "" }
  })
  const setRow = (r: Row, patch: Partial<Row>) => set("rows", { ...f.rows, [r.key]: { ...r, ...patch } })
  const taken = useQuery(api.website.skusTaken, { skus: variants.map((v) => v.sku) }) ?? []

  // what each size sells for on the website
  const booking = BOOKING[f.from]
  const full = (r: Row) => num(r.price || f.price)
  const plainDesc = f.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()

  async function onFiles(files: File[]) {
    setUploading(true)
    try { const add = await uploadImages(files, () => uploadUrl({}), (x) => fileUrl(x), f.title); if (add.length) setF((x) => ({ ...x, images: [...x.images, ...add] })) }
    catch (e) { toast.error(errMsg(e)) } finally { setUploading(false) }
  }

  async function onSave() {
    if (!f.title.trim()) { toast.error("Add a title"); return }
    if (!variants.length) { toast.error("Add at least one size (e.g. 39, 40, 41)"); return }
    if (variants.some((r) => !full(r))) { toast.error(f.preOrder ? "Add the full price" : "Add a price"); return }
    if (taken.length) { toast.error(`SKU already used: ${taken.join(", ")}`); return }
    setSaving(true)
    try {
      const mf: Record<string, string> = {}
      if (f.preOrder) {
        if (f.supplier.trim()) mf["custom.supplier"] = f.supplier.trim()
        if (f.days.trim()) mf["bb26.pre_days"] = f.days.trim()
        if (f.from === "bangladesh") mf["bb26.pre_fee"] = String(BOOKING.bangladesh)
      }
      const id = await create({
        title: f.title, handle: f.handle, html: f.html, vendor: f.vendor, type: f.type, tags: f.tags,
        seo: { title: f.seoTitle, description: f.seoDesc }, options: f.opts.map((o) => o.name), images: f.images, mf,
        published: f.published, preOrder: f.preOrder, preOrderFrom: f.from, collections: f.colls as Id<"webCollections">[],
        variants: variants.map((r) => {
          const fp = full(r)
          const cmp = num(r.compareAt || f.compareAt)
          return {
            sku: r.sku, title: r.title, options: r.options,
            price: f.preOrder ? booking : fp,
            fullPrice: fp,
            compareAt: f.preOrder ? fp : cmp > fp ? cmp : null,
            cost: num(r.cost || f.cost), weightKg: Number(f.weight) || 0.5,
          }
        }),
      })
      markSaved(f)
      toast.success(f.published ? "Product created — live on the website in about a minute" : "Product created (hidden)")
      setTimeout(() => navigate({ to: "/website-product", search: { id } }), 0)
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }

  if (colls === undefined || products === undefined) return <Loading />
  const firstFull = variants[0] ? full(variants[0]) : num(f.price)
  return (
    <div className="mx-auto max-w-6xl pb-24">
      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onDiscard={() => setF(empty)} message="Unsaved product" />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button size="icon" variant="outline" className="size-8" asChild><Link to="/website" search={{ tab: "products", view: "live" }} aria-label="Back to Website"><ArrowLeft className="size-4" /></Link></Button>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">{f.title || "Add product"}</h1>
        <Button size="sm" disabled={saving} onClick={onSave}>{saving ? "Saving" : "Save"}</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="min-w-0 space-y-4">
          <Section>
            <div className="space-y-4">
              <Field label="Title"><Input autoFocus value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. BlackBole Harbor Shore Sandal for Men - Black" className="h-10 text-[15px]" /></Field>
              <Field label="Description"><RichText value={f.html} onChange={(v) => set("html", v)} /></Field>
            </div>
          </Section>

          <Section title="Media">
            <MediaGrid images={f.images} onChange={(v) => set("images", v)} onFiles={onFiles} uploading={uploading} defaultAlt={f.title} />
          </Section>

          <Section title="Pricing" sub={f.preOrder ? `Pre-order: shoppers pay ${taka(booking)} online${f.from === "china" ? " + delivery" : ""}, the rest on delivery.` : "Applies to every size; you can change any size below."}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={f.preOrder ? "Full price" : "Price"}><Money value={f.price} onChange={(v) => set("price", v)} /></Field>
              {!f.preOrder && <Field label="Compare-at price" hint="Shown crossed out"><Money value={f.compareAt} onChange={(v) => set("compareAt", v)} /></Field>}
              {f.preOrder && <Field label="Booking (paid online)"><Input disabled value={`৳ ${booking}`} /></Field>}
              <Field label="Cost per item" hint="Only staff see this">
                <Money value={f.cost} onChange={(v) => set("cost", v)} />
              </Field>
            </div>
            {firstFull > 0 && num(f.cost) > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">Profit {taka(firstFull - num(f.cost))} · margin {Math.round(((firstFull - num(f.cost)) / firstFull) * 100)}%</p>
            )}
            {f.preOrder && firstFull > 0 && <p className="mt-3 rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground">Shopper pays <b className="text-foreground">{taka(booking)}</b> now{f.from === "china" ? " + delivery" : " (it is the delivery charge)"} and <b className="text-foreground">{taka(firstFull - booking)}</b> on delivery.</p>}
          </Section>

          <Section title="Sizes" sub="Type the values and press Enter. Every combination becomes a size with its own SKU and price.">
            <div className="space-y-3">
              {f.opts.map((o, i) => (
                <div key={i} className="rounded-lg border p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Input value={o.name} onChange={(e) => set("opts", f.opts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder={i ? "Colour" : "Size"} className="h-8 max-w-44" />
                    {i === 0 && !o.values.length && (
                      <div className="flex flex-wrap gap-1">
                        {[["Men 39–44", ["39", "40", "41", "42", "43", "44"]], ["Women 35–41", ["35", "36", "37", "38", "39", "40", "41"]], ["S–XL", ["S", "M", "L", "XL"]]].map(([l, vals]) => (
                          <Button key={l as string} size="sm" variant="outline" className="h-7 text-xs" onClick={() => set("opts", f.opts.map((x, j) => (j === i ? { ...x, values: vals as string[] } : x)))}><Wand2 className="size-3" /> {l as string}</Button>
                        ))}
                      </div>
                    )}
                    {f.opts.length > 1 && <Button size="icon" variant="ghost" className="ml-auto size-8" aria-label="Remove option" onClick={() => set("opts", f.opts.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>}
                  </div>
                  <ValuesInput values={o.values} onChange={(v) => set("opts", f.opts.map((x, j) => (j === i ? { ...x, values: v } : x)))} placeholder={i ? "Black, Brown…" : "39, 40, 41…"} />
                </div>
              ))}
              {f.opts.length < 3 && <Button size="sm" variant="outline" onClick={() => set("opts", [...f.opts, { name: f.opts.length === 1 ? "Colour" : "", values: [] }])}><Plus className="size-4" /> Add another option (e.g. Colour)</Button>}
            </div>

            {variants.length > 0 && (
              <>
                <div className="mt-4 flex flex-wrap items-end gap-3">
                  <Field label="SKU start" hint={`e.g. ${variants[0].sku}`}><Input value={f.skuPrefix} placeholder={autoPrefix(f.title)} onChange={(e) => set("skuPrefix", e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))} className="h-8 w-40" /></Field>
                  <Field label="Weight per pair (kg)"><Input value={f.weight} inputMode="decimal" onChange={(e) => set("weight", e.target.value.replace(/[^\d.]/g, ""))} className="h-8 w-28" /></Field>
                </div>
                <div className="-mx-4 mt-3 overflow-x-auto border-t">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/30 text-left text-xs text-muted-foreground">
                      <tr className="border-b"><th className="py-2 pl-4 pr-3 font-medium">Size</th><th className="py-2 pr-3 font-medium">SKU</th><th className="py-2 pr-3 font-medium">{f.preOrder ? "Full price" : "Price"}</th>{!f.preOrder && <th className="py-2 pr-3 font-medium">Compare-at</th>}<th className="py-2 pr-4 font-medium">Cost</th></tr>
                    </thead>
                    <tbody>
                      {variants.map((r) => (
                        <tr key={r.key} className="border-b last:border-0">
                          <td className="py-1.5 pl-4 pr-3 font-medium">{r.title}</td>
                          <td className="py-1.5 pr-3">
                            <Input value={r.sku} onChange={(e) => setRow(r, { sku: e.target.value.toUpperCase().replace(/\s+/g, "") })} className={cn("h-8 w-48 font-mono text-xs", taken.includes(r.sku) && "border-tone-red")} title={taken.includes(r.sku) ? "Already used by another product" : undefined} />
                          </td>
                          <td className="py-1.5 pr-3"><Money small value={r.price} placeholder={f.price} onChange={(v) => setRow(r, { price: v })} /></td>
                          {!f.preOrder && <td className="py-1.5 pr-3"><Money small value={r.compareAt} placeholder={f.compareAt} onChange={(v) => setRow(r, { compareAt: v })} /></td>}
                          <td className="py-1.5 pr-4"><Money small value={r.cost} placeholder={f.cost} onChange={(v) => setRow(r, { cost: v })} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {taken.length > 0 && <p className="mt-2 flex items-center gap-1.5 text-xs text-tone-red"><AlertTriangle className="size-3.5" /> SKU already used by another product: {taken.join(", ")}</p>}
              </>
            )}
          </Section>

          <SeoCard site={SITE_URL} path="products" handle={f.handle} onHandle={(v) => set("handle", v)}
            title={f.seoTitle} onTitle={(v) => set("seoTitle", v)} desc={f.seoDesc} onDesc={(v) => set("seoDesc", v)}
            fallbackTitle={f.title} fallbackDesc={plainDesc} />
        </div>

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
          </Section>

          <Section title="Pre-order" action={<Switch checked={f.preOrder} onCheckedChange={(v) => set("preOrder", v)} aria-label="Pre-order" />}
            sub={f.preOrder ? "Booked online; no stock needed." : "Turn on for items made or shipped after the order."}>
            {f.preOrder ? (
              <div className="space-y-3">
                <Field label="Comes from">
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                    {(["china", "bangladesh"] as const).map((o) => (
                      <button key={o} type="button" onClick={() => set("from", o)}
                        className={cn("rounded-md py-1.5 text-sm font-medium transition-colors", f.from === o ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                        {o === "china" ? "China · ৳500" : "Bangladesh · ৳90"}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Supplier" hint="Shown as a small badge on the product."><Input value={f.supplier} onChange={(e) => set("supplier", e.target.value)} placeholder="e.g. Doris Chen" /></Field>
                <Field label="Ready in (days)"><Input value={f.days} onChange={(e) => set("days", e.target.value)} placeholder="15–20" /></Field>
              </div>
            ) : null}
          </Section>

          <Section title="Organization">
            <div className="space-y-4">
              <Field label="Type"><SuggestInput value={f.type} onChange={(v) => set("type", v)} suggestions={types} placeholder="e.g. Sandals" /></Field>
              <Field label="Brand"><Input value={f.vendor} onChange={(e) => set("vendor", e.target.value)} /></Field>
              <Field label="Collections"><CollectionPicker all={allColls} value={f.colls} onChange={(v) => set("colls", v)} /></Field>
              <Field label="Tags"><TagInput value={f.tags} onChange={(v) => set("tags", v)} suggestions={[]} /></Field>
            </div>
          </Section>

          <Section title="Stock">
            <p className="text-sm text-muted-foreground">{f.preOrder ? "Pre-orders don't need stock." : "Add pairs through Purchases & stock in. Until then the product shows as sold out."}</p>
          </Section>
        </div>
      </div>
    </div>
  )
}

function Money({ value, onChange, placeholder, small }: { value: string; onChange: (v: string) => void; placeholder?: string; small?: boolean }) {
  return (
    <div className={cn("relative", small ? "w-28" : "")}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">৳</span>
      <Input inputMode="numeric" value={value} placeholder={placeholder || "0"} onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))} className={cn("pl-6 tabular-nums", small && "h-8")} />
    </div>
  )
}

function ValuesInput({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [q, setQ] = useState("")
  const add = (raw: string) => {
    const parts = raw.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).filter((x) => !values.includes(x))
    if (parts.length) onChange([...values, ...parts])
    setQ("")
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-background p-1.5 focus-within:ring-2 focus-within:ring-ring/20">
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-sm">
          {v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
        </span>
      ))}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={values.length ? "" : placeholder}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === ",") && q.trim()) { e.preventDefault(); add(q) }
          if (e.key === "Backspace" && !q && values.length) onChange(values.slice(0, -1))
        }}
        onBlur={() => q.trim() && add(q)} onPaste={(e) => { const t = e.clipboardData.getData("text"); if (/[,\n]/.test(t)) { e.preventDefault(); add(t) } }}
        className="h-7 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none" />
    </div>
  )
}

