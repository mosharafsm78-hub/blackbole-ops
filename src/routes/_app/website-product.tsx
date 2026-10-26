import { useEffect, useRef, useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ArrowLeft, ArrowLeft as Left, ArrowRight, ExternalLink, ImagePlus, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading, PageHeader } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { errMsg, taka } from "@/lib/format"

export const Route = createFileRoute("/_app/website-product")({
  validateSearch: (s: Record<string, unknown>) => ({ id: String(s.id ?? "") }),
  component: () => <WebsiteGuard><Editor /></WebsiteGuard>,
})

const SITE = "https://blackbole.com"

/** Friendly names for the website's extra fields (web.mf). Unknown keys show their key. */
const MF_LABEL: Record<string, string> = {
  "bb26.short": "Short line under price",
  "bb26.parts": "Parts / materials",
  "bb26.pre_days": "Pre-order days",
  "bb26.pre_fee": "Pre-order booking = delivery charge (Taka)",
  "bb26.pre_note_title": "Pre-order note title",
  "bb26.pre_note_text": "Pre-order note text",
  "bb26.colours": "Colours (other colour products)",
  "custom.supplier": "Supplier badge (pre-order)",
  "custom.real_photos": "Real photos",
  "global.title_tag": "Old SEO title (Shopify)",
  "global.description_tag": "Old SEO description (Shopify)",
}
const looksJson = (s: string) => /^\s*[[{]/.test(s)
const PRE_TAG = "pre-order"

type Img = { url: string; alt: string; w: number | null; h: number | null }
type Var = { id: Id<"variants">; sku: string; title: string; price: number; active: boolean; compareAt: string; options: Record<string, string> }

function Editor() {
  const { id } = Route.useSearch()
  const data = useQuery(api.website.product, { id: id as Id<"products"> })
  if (data === undefined) return <Loading />
  if (data === null) return <p className="text-sm text-muted-foreground">Product not found.</p>
  return <Form key={data.product._id} data={data} />
}

function Form({ data }: { data: NonNullable<ReturnType<typeof useQuery<typeof api.website.product>>> }) {
  const p = data.product
  const w: any = p.web ?? {}
  const save = useMutation(api.website.saveProduct)
  const uploadUrl = useMutation(api.website.uploadUrl)
  const fileUrl = useMutation(api.website.fileUrl)
  const fileRef = useRef<HTMLInputElement>(null)

  const [title, setTitle] = useState<string>(w.title || p.name)
  const [handle, setHandle] = useState<string>(p.handle)
  const [html, setHtml] = useState<string>(w.html ?? p.description ?? "")
  const [type, setType] = useState<string>(w.type ?? p.category ?? "")
  const [vendor, setVendor] = useState<string>(w.vendor ?? "BlackBole")
  const [tags, setTags] = useState<string>((w.tags ?? []).join(", "))
  const [seoTitle, setSeoTitle] = useState<string>(w.seo?.title ?? "")
  const [seoDesc, setSeoDesc] = useState<string>(w.seo?.description ?? "")
  const [published, setPublished] = useState<boolean>(!!w.published)
  const [options, setOptions] = useState<string[]>((w.options ?? []).map((o: any) => o.name).filter(Boolean).length ? (w.options ?? []).map((o: any) => o.name) : ["Size"])
  const [images, setImages] = useState<Img[]>((w.images ?? (p.imageUrl ? [{ url: p.imageUrl, alt: title }] : [])).map((i: any) => ({ url: i.url, alt: i.alt ?? "", w: i.w ?? null, h: i.h ?? null })))
  const [mf, setMf] = useState<[string, string][]>(Object.entries(w.mf ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]))
  const [newKey, setNewKey] = useState("")
  const [newVal, setNewVal] = useState("")
  const [vars, setVars] = useState<Var[]>(data.variants.map((v) => ({
    id: v._id, sku: v.sku, title: v.title, price: v.price, active: v.active,
    compareAt: v.web?.compareAt ? String(v.web.compareAt) : "", options: { ...(v.web?.options ?? {}) },
  })))
  const [colls, setColls] = useState<Set<string>>(new Set(data.collections.filter((c) => c.member).map((c) => c._id as string)))
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)

  // Fill empty option values from the variant title on first open (e.g. "41" → Size: 41)
  useEffect(() => {
    if (options.length === 1) setVars((vs) => vs.map((v) => (v.options[options[0]] ? v : { ...v, options: { ...v.options, [options[0]]: v.title } })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean)
  const preOrder = tagList.some((t) => t.toLowerCase() === PRE_TAG)
  const setPreOrder = (on: boolean) => {
    const rest = tagList.filter((t) => t.toLowerCase() !== PRE_TAG)
    setTags((on ? [...rest, PRE_TAG] : rest).join(", "))
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return
    setUploading(true)
    try {
      const added: Img[] = []
      for (const f of Array.from(files)) {
        const url = await uploadUrl({})
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f })
        if (!res.ok) throw new Error("Upload failed")
        const { storageId } = await res.json()
        const publicUrl = await fileUrl({ storageId })
        const size = await imageSize(f)
        added.push({ url: publicUrl, alt: title, w: size?.w ?? null, h: size?.h ?? null })
      }
      setImages((l) => [...l, ...added])
      toast.success(`${added.length} photo${added.length > 1 ? "s" : ""} added — press Save`)
    } catch (e) { toast.error(errMsg(e)) } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const moveImg = (i: number, d: number) => setImages((l) => { const n = [...l]; const j = i + d; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n })
  const moveVar = (i: number, d: number) => setVars((l) => { const n = [...l]; const j = i + d; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n })

  async function onSave() {
    setBusy(true)
    try {
      const mfObj: Record<string, string> = {}
      for (const [k, v] of mf) if (k.trim()) mfObj[k.trim()] = v
      const h = await save({
        id: p._id, handle, title, html, vendor, type, tags: tagList,
        seo: { title: seoTitle, description: seoDesc }, options: options.map((o) => o.trim()).filter(Boolean),
        images: images.map((i) => ({ url: i.url, alt: i.alt, w: i.w, h: i.h })), mf: mfObj, published,
        variants: vars.map((v) => ({ id: v.id, compareAt: v.compareAt.trim() ? Number(v.compareAt) || null : null, options: v.options })),
        collections: [...colls] as Id<"webCollections">[],
      })
      setHandle(h)
      toast.success("Saved — the website updates after the next rebuild (about 2 minutes)")
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4 pb-20">
      <PageHeader title={title || p.name} sub={<>Ops product: {p.name}{p.handle && <> · <a className="inline-flex items-center gap-1 underline" href={`${SITE}/products/${p.handle}`} target="_blank" rel="noreferrer">View on website <ExternalLink className="size-3" /></a></>}</>}>
        <Button variant="outline" size="sm" asChild><Link to="/website" search={{ tab: "products" }}><ArrowLeft className="size-4" /> Website</Link></Button>
        <label className="flex items-center gap-2 text-sm"><Switch checked={published} onCheckedChange={setPublished} /> On website</label>
        <Button size="sm" disabled={busy || uploading} onClick={onSave}>{busy ? "Saving…" : "Save"}</Button>
      </PageHeader>

      <Card title="Photos" sub="The first photo is the main one. Use the arrows to change the order.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {images.map((img, i) => (
            <div key={img.url + i} className="space-y-1 rounded-md border p-1.5">
              <img src={img.url} alt={img.alt} className="aspect-square w-full rounded object-cover" />
              <Input value={img.alt} placeholder="Alt text" className="h-7 text-xs" onChange={(e) => setImages((l) => l.map((x, j) => (j === i ? { ...x, alt: e.target.value } : x)))} />
              <div className="flex justify-between">
                <Button size="icon" variant="ghost" className="size-7" disabled={i === 0} onClick={() => moveImg(i, -1)} aria-label="Move left"><Left className="size-4" /></Button>
                <Button size="icon" variant="ghost" className="size-7 text-tone-red" onClick={() => setImages((l) => l.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 className="size-4" /></Button>
                <Button size="icon" variant="ghost" className="size-7" disabled={i === images.length - 1} onClick={() => moveImg(i, 1)} aria-label="Move right"><ArrowRight className="size-4" /></Button>
              </div>
            </div>
          ))}
          <button type="button" disabled={uploading} onClick={() => fileRef.current?.click()} className="flex aspect-square flex-col items-center justify-center gap-1 rounded-md border border-dashed text-sm text-muted-foreground hover:bg-muted/40">
            <ImagePlus className="size-5" />{uploading ? "Uploading…" : "Add photos"}
          </button>
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
        </div>
      </Card>

      <Card title="Details">
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label>Title</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div><Label>URL handle</Label><Input value={handle} placeholder="made from the title" onChange={(e) => setHandle(e.target.value)} /><p className="mt-1 text-xs text-muted-foreground">Changing it changes the product's web address.</p></div>
          <div><Label>Type</Label><Input value={type} onChange={(e) => setType(e.target.value)} placeholder="Sandals" /></div>
          <div><Label>Vendor</Label><Input value={vendor} onChange={(e) => setVendor(e.target.value)} /></div>
          <div className="sm:col-span-2"><Label>Tags (comma separated)</Label><Input value={tags} onChange={(e) => setTags(e.target.value)} /></div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><Switch checked={preOrder} onCheckedChange={setPreOrder} /> Pre-order on the website <span className="text-xs text-muted-foreground">(adds the “pre-order” tag)</span></label>
          <div className="sm:col-span-2"><Label>Description (HTML)</Label><Textarea rows={8} className="font-mono text-xs" value={html} onChange={(e) => setHtml(e.target.value)} /></div>
        </div>
      </Card>

      <Card title="Sizes and prices" sub="Price, SKU and stock come from Ops (edit them on Products). Here you set the website's crossed-out price and option values.">
        <div className="mb-3 flex flex-wrap items-end gap-2">
          {options.map((o, i) => (
            <div key={i} className="w-36"><Label className="text-xs">Option {i + 1} name</Label>
              <div className="flex gap-1"><Input value={o} onChange={(e) => {
                const old = options[i], name = e.target.value
                setOptions(options.map((x, j) => (j === i ? name : x)))
                setVars((vs) => vs.map((v) => { const { [old]: val, ...rest } = v.options; return { ...v, options: { ...rest, [name]: val ?? "" } } }))
              }} />
                {options.length > 1 && <Button size="icon" variant="ghost" onClick={() => setOptions(options.filter((_, j) => j !== i))} aria-label="Remove option"><Trash2 className="size-4" /></Button>}
              </div>
            </div>
          ))}
          {options.length < 3 && <Button size="sm" variant="outline" onClick={() => setOptions([...options, ""])}><Plus className="size-4" /> Option</Button>}
        </div>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2 font-medium">Variant</th><th className="p-2 font-medium">SKU</th><th className="p-2 text-right font-medium">Price</th><th className="p-2 font-medium">Compare-at</th>
                {options.map((o, i) => <th key={i} className="p-2 font-medium">{o || `Option ${i + 1}`}</th>)}<th className="p-2" /></tr>
            </thead>
            <tbody className="divide-y">
              {vars.map((v, i) => (
                <tr key={v.id} className={v.active ? "" : "opacity-50"}>
                  <td className="p-2">{v.title}</td>
                  <td className="p-2 font-mono text-xs">{v.sku}</td>
                  <td className="p-2 text-right tabular-nums">{taka(v.price)}</td>
                  <td className="p-2"><Input className="h-8 w-24" inputMode="numeric" value={v.compareAt} placeholder="—" onChange={(e) => setVars((l) => l.map((x, j) => (j === i ? { ...x, compareAt: e.target.value.replace(/[^\d]/g, "") } : x)))} /></td>
                  {options.map((o, k) => (
                    <td key={k} className="p-2"><Input className="h-8 w-28" value={v.options[o] ?? ""} onChange={(e) => setVars((l) => l.map((x, j) => (j === i ? { ...x, options: { ...x.options, [o]: e.target.value } } : x)))} /></td>
                  ))}
                  <td className="whitespace-nowrap p-2">
                    <Button size="icon" variant="ghost" className="size-7" disabled={i === 0} onClick={() => moveVar(i, -1)} aria-label="Move up">↑</Button>
                    <Button size="icon" variant="ghost" className="size-7" disabled={i === vars.length - 1} onClick={() => moveVar(i, 1)} aria-label="Move down">↓</Button>
                  </td>
                </tr>
              ))}
              {vars.length === 0 && <tr><td colSpan={5 + options.length} className="p-3 text-muted-foreground">No variants. Add sizes on the Products page first.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Collections">
        {data.collections.length === 0 ? <p className="text-sm text-muted-foreground">No collections yet — create them on Website → Collections.</p> : (
          <div className="grid gap-2 sm:grid-cols-3">
            {data.collections.map((c) => (
              <label key={c._id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={colls.has(c._id)} onCheckedChange={(on) => setColls((s) => { const n = new Set(s); on ? n.add(c._id) : n.delete(c._id); return n })} />{c.title}
              </label>
            ))}
          </div>
        )}
      </Card>

      <Card title="Search engines (SEO)">
        <div className="grid gap-3">
          <div><Label>SEO title</Label><Input value={seoTitle} placeholder={title} onChange={(e) => setSeoTitle(e.target.value)} /></div>
          <div><Label>SEO description</Label><Textarea rows={2} value={seoDesc} onChange={(e) => setSeoDesc(e.target.value)} /></div>
        </div>
      </Card>

      <Card title="More details" sub="Extra content the website shows on this product (short line, pre-order notes, colours…).">
        <div className="space-y-3">
          {mf.length === 0 && <p className="text-sm text-muted-foreground">No extra fields.</p>}
          {mf.map(([k, val], i) => (
            <div key={k + i} className="grid gap-1 sm:grid-cols-[14rem_1fr_auto] sm:items-start sm:gap-3">
              <div className="pt-1.5"><div className="text-sm font-medium">{MF_LABEL[k] ?? k}</div>{MF_LABEL[k] && <div className="font-mono text-[11px] text-muted-foreground">{k}</div>}</div>
              {looksJson(val) || val.length > 80
                ? <Textarea rows={looksJson(val) ? 4 : 2} className={looksJson(val) ? "font-mono text-xs" : ""} value={val} onChange={(e) => setMf((l) => l.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                : <Input value={val} onChange={(e) => setMf((l) => l.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />}
              <Button size="icon" variant="ghost" className="text-tone-red" onClick={() => setMf((l) => l.filter((_, j) => j !== i))} aria-label="Remove field"><Trash2 className="size-4" /></Button>
            </div>
          ))}
          <div className="flex flex-wrap items-end gap-2 border-t pt-3">
            <div className="w-56"><Label className="text-xs">New field key</Label><Input value={newKey} placeholder="bb26.short" list="mf-keys" onChange={(e) => setNewKey(e.target.value)} /></div>
            <datalist id="mf-keys">{Object.keys(MF_LABEL).filter((k) => !mf.some(([x]) => x === k)).map((k) => <option key={k} value={k}>{MF_LABEL[k]}</option>)}</datalist>
            <div className="min-w-48 flex-1"><Label className="text-xs">Value</Label><Input value={newVal} onChange={(e) => setNewVal(e.target.value)} /></div>
            <Button variant="outline" disabled={!newKey.trim()} onClick={() => {
              const k = newKey.trim()
              if (mf.some(([x]) => x === k)) { toast.error("That field is already there"); return }
              setMf([...mf, [k, newVal]]); setNewKey(""); setNewVal("")
            }}><Plus className="size-4" /> Add field</Button>
          </div>
        </div>
      </Card>

      <div className="sticky bottom-0 -mx-1 flex justify-end gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur">
        <Button variant="outline" asChild><Link to="/website" search={{ tab: "products" }}>Back</Link></Button>
        <Button disabled={busy || uploading} onClick={onSave}>{busy ? "Saving…" : "Save"}</Button>
      </div>
    </div>
  )
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="font-semibold">{title}</h2>
      {sub && <p className="mb-3 mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      <div className={sub ? "" : "mt-3"}>{children}</div>
    </section>
  )
}

function imageSize(f: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f)
    const img = new Image()
    img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url) }
    img.onerror = () => { resolve(null); URL.revokeObjectURL(url) }
    img.src = url
  })
}
