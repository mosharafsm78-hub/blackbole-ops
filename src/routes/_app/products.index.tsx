import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ChevronDown, ChevronRight, Plus, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Guard, useCan, Perm } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill, Stat } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { TEMPLATE_CSV, mapProductCsv, type ImportRow } from "@/lib/csv"
import { errMsg, taka } from "@/lib/format"
import { useUploadFiles } from "@/components/file-picker"
import { isPreOrderSku } from "@/convex/rules"

export const Route = createFileRoute("/_app/products/")({
  component: () => (
    <Guard perm="orders.view">
      <ProductsPage />
    </Guard>
  ),
})

type VariantForm = { id?: Id<"variants">; sku: string; title: string; weightKg: number; price: number; purchasePrice: number; active: boolean }
type ProductForm = { id?: Id<"products">; name: string; category: string; imageUrl: string; active: boolean; preOrder: boolean; preOrderFrom: "china" | "bangladesh"; variants: VariantForm[] }

const blank = (): ProductForm => ({ name: "", category: "", imageUrl: "", active: true, preOrder: false, preOrderFrom: "china", variants: [] })

function ProductsPage() {
  const can = useCan()
  const products = useQuery(api.catalog.listProducts)
  const [q, setQ] = useState("")
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<ProductForm | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!products) return []
    if (!t) return products
    return products.filter((p) => p.name.toLowerCase().includes(t) || p.variants.some((v) => v.sku.toLowerCase().includes(t)) || (p.category ?? "").toLowerCase().includes(t))
  }, [products, q])

  if (products === undefined || products === null) return <Loading />
  const variantCount = products.reduce((s, p) => s + p.variants.length, 0)

  return (
    <div>
      <PageHeader title="Products & pricing" sub="Every SKU the team can sell. Shopify orders match products by SKU.">
        <Perm perm="products.manage"><Button variant="outline" size="sm" onClick={() => setImportOpen(true)}><Upload className="size-4" /> Import CSV</Button></Perm>
        <Perm perm="products.manage"><Button size="sm" onClick={() => setEditing(blank())}><Plus className="size-4" /> Add product</Button></Perm>
      </PageHeader>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Products" value={products.length} />
        <Stat label="SKUs" value={variantCount} />
        <Stat label="Active products" value={products.filter((p) => p.active).length} />
        <Stat label="Inactive" value={products.filter((p) => !p.active).length} />
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, SKU or category" className="mb-3 max-w-sm" />
      {products.length === 0 ? (
        <Empty title="No products yet">Add products one by one, or import a CSV (our template or Shopify's product export).</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-8 p-3" /><th className="p-3 font-medium">Product</th><th className="p-3 font-medium">Category</th>
                <th className="p-3 font-medium">SKUs</th><th className="p-3 text-right font-medium">Price</th><th className="p-3 text-right font-medium">In stock</th><th className="p-3 font-medium">Status</th><th className="p-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((p) => {
                const isOpen = open.has(p._id)
                const prices = p.variants.map((v) => v.price)
                const stock = p.variants.reduce((s, v) => s + v.stock.available, 0)
                return (
                  <FragmentRows key={p._id}>
                    <tr className="hover:bg-muted/30">
                      <td className="p-3">
                        <button onClick={() => { const n = new Set(open); if (isOpen) n.delete(p._id); else n.add(p._id); setOpen(n) }} aria-label="Show variants">
                          {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </button>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          {p.imageUrl ? <img src={p.imageUrl} alt="" className="size-10 rounded object-cover" /> : <div className="size-10 rounded bg-muted" />}
                          <span className="font-medium">{p.name}</span>
                        </div>
                      </td>
                      <td className="p-3 text-muted-foreground">{p.category || "—"}</td>
                      <td className="p-3 tabular-nums">{p.variants.length}</td>
                      <td className="p-3 text-right tabular-nums">{prices.length ? (Math.min(...prices) === Math.max(...prices) ? taka(prices[0]) : `${taka(Math.min(...prices))}–${taka(Math.max(...prices))}`) : "—"}</td>
                      <td className={`p-3 text-right tabular-nums ${stock <= 0 ? "text-tone-red" : ""}`}>{stock}</td>
                      <td className="p-3">{p.active ? <Pill tone="green">Active</Pill> : <Pill tone="gray">Inactive</Pill>}{(p.preOrder || p.variants.some((v) => isPreOrderSku(v.sku))) && <Pill tone="pink" className="ml-1">Pre-order · {p.preOrderFrom === "bangladesh" ? "BD" : "China"}</Pill>}</td>
                      <td className="p-3 text-right">
                        {can("products.manage") && (
                          <Button variant="ghost" size="sm" onClick={() => setEditing({
                            id: p._id, name: p.name, category: p.category ?? "", imageUrl: p.imageUrl ?? "", active: p.active, preOrder: !!p.preOrder, preOrderFrom: p.preOrderFrom ?? "china",
                            variants: p.variants.map((v) => ({ id: v._id, sku: v.sku, title: v.title, weightKg: v.weightKg, price: v.price, purchasePrice: v.purchasePrice, active: v.active })),
                          })}>Edit</Button>
                        )}
                      </td>
                    </tr>
                    {isOpen && p.variants.map((v) => (
                      <tr key={v._id} className="bg-muted/20 text-xs">
                        <td /><td className="p-2 pl-14">{v.title} <span className="text-muted-foreground">· {v.sku}</span>{!v.active && <span className="ml-2 text-muted-foreground">(inactive)</span>}</td>
                        <td className="p-2 text-muted-foreground">{v.weightKg} kg</td>
                        <td className="p-2 text-muted-foreground">Cost {taka(v.purchasePrice)}</td>
                        <td className="p-2 text-right tabular-nums">{taka(v.price)}</td>
                        <td className="p-2 text-right tabular-nums">{v.stock.available}</td>
                        <td colSpan={2} className="p-2 text-muted-foreground">Processing {v.stock.processing} · Transit {v.stock.inTransit}</td>
                      </tr>
                    ))}
                  </FragmentRows>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && <ProductDialog initial={editing} onClose={() => setEditing(null)} />}
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  )
}

function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

function ProductDialog({ initial, onClose }: { initial: ProductForm; onClose: () => void }) {
  const save = useMutation(api.catalog.saveProduct)
  const [f, setF] = useState<ProductForm>(initial)
  const photo = useUploadFiles()
  const [sizes, setSizes] = useState("")
  const [baseSku, setBaseSku] = useState("")
  const [basePrice, setBasePrice] = useState(0)
  const [baseCost, setBaseCost] = useState(0)
  const [baseWeight, setBaseWeight] = useState(0.5)
  const [busy, setBusy] = useState(false)
  const setV = (i: number, patch: Partial<VariantForm>) => setF({ ...f, variants: f.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) })

  const generate = () => {
    const list = sizes.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    if (!baseSku.trim() || list.length === 0) return toast.error("Enter a base SKU and at least one size")
    const existing = new Set(f.variants.map((v) => v.sku))
    const add = list
      .map((s) => ({ sku: `${baseSku.trim().toUpperCase()}-${s.toUpperCase()}`, title: s, weightKg: baseWeight, price: basePrice, purchasePrice: baseCost, active: true }))
      .filter((v) => !existing.has(v.sku))
    setF({ ...f, variants: [...f.variants, ...add] })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{f.id ? "Edit product" : "Add product"}</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2"><Label>Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="BlackBole Harbor Shore Sandal - Black" /></div>
          <div className="space-y-1.5"><Label>Category</Label><Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Sandals" /></div>
          <div className="space-y-1.5">
            <Label>Photo</Label>
            <div className="flex items-center gap-2">
              {f.imageUrl && <img src={f.imageUrl} alt="" className="size-9 shrink-0 rounded border object-cover" />}
              <Input value={f.imageUrl} onChange={(e) => setF({ ...f, imageUrl: e.target.value })} placeholder="Upload a photo, or paste a link (https://…)" />
              <label className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted">
                <Upload className="size-4" /> {photo.busy ? "Uploading…" : "Upload"}
                <input type="file" accept="image/*" className="hidden" disabled={photo.busy > 0}
                  onChange={async (e) => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; const [url] = await photo.upload([file]); if (url) setF((cur) => ({ ...cur, imageUrl: url })) }} />
              </label>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm"><Switch checked={f.active} onCheckedChange={(v) => setF({ ...f, active: v })} /> Active (can be sold)</label>
          <label className="flex items-center gap-2 text-sm"><Switch checked={f.preOrder} onCheckedChange={(v) => setF({ ...f, preOrder: v })} /> Pre-order product (takes long to arrive — orders go to the Pre-Order tab). SKUs starting with “PO-” count as pre-order automatically.</label>
          <div className="flex items-center gap-2 text-sm">
            <span>Pre-order comes from</span>
            <Select value={f.preOrderFrom} onValueChange={(v) => setF({ ...f, preOrderFrom: v as "china" | "bangladesh" })}>
              <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="china">China (import)</SelectItem><SelectItem value="bangladesh">Bangladesh (local)</SelectItem></SelectContent>
            </Select>
          </div>
        </div>

        <div className="rounded-md border border-dashed p-3">
          <div className="mb-2 text-sm font-medium">Quick add sizes</div>
          <div className="grid gap-2 sm:grid-cols-5">
            <Input placeholder="Base SKU e.g. BB-SH-HSS-BLACK" value={baseSku} onChange={(e) => setBaseSku(e.target.value)} className="sm:col-span-2" />
            <Input placeholder="Sizes: 39,40,41,42" value={sizes} onChange={(e) => setSizes(e.target.value)} className="sm:col-span-3" />
            <label className="text-xs">Price<Input type="number" value={basePrice} onChange={(e) => setBasePrice(Number(e.target.value) || 0)} /></label>
            <label className="text-xs">Cost<Input type="number" value={baseCost} onChange={(e) => setBaseCost(Number(e.target.value) || 0)} /></label>
            <label className="text-xs">Weight kg<Input type="number" step="0.1" value={baseWeight} onChange={(e) => setBaseWeight(Number(e.target.value) || 0)} /></label>
            <div className="flex items-end sm:col-span-2"><Button variant="outline" className="w-full" onClick={generate}>Generate variants</Button></div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Variants ({f.variants.length})</div>
            <Button size="xs" variant="outline" onClick={() => setF({ ...f, variants: [...f.variants, { sku: "", title: "", weightKg: 0.5, price: 0, purchasePrice: 0, active: true }] })}>
              <Plus className="size-3" /> Add one
            </Button>
          </div>
          <div className="hidden grid-cols-[1.4fr_0.8fr_0.7fr_0.7fr_0.6fr_auto_auto] gap-2 px-1 text-xs text-muted-foreground sm:grid">
            <span>SKU</span><span>Size / option</span><span>Price</span><span>Cost</span><span>Weight kg</span><span>Active</span><span />
          </div>
          {f.variants.map((v, i) => (
            <div key={i} className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[1.4fr_0.8fr_0.7fr_0.7fr_0.6fr_auto_auto]">
              <Input value={v.sku} onChange={(e) => setV(i, { sku: e.target.value })} placeholder="SKU" />
              <Input value={v.title} onChange={(e) => setV(i, { title: e.target.value })} placeholder="42" />
              <Input type="number" value={v.price} onChange={(e) => setV(i, { price: Number(e.target.value) || 0 })} />
              <Input type="number" value={v.purchasePrice} onChange={(e) => setV(i, { purchasePrice: Number(e.target.value) || 0 })} />
              <Input type="number" step="0.1" value={v.weightKg} onChange={(e) => setV(i, { weightKg: Number(e.target.value) || 0 })} />
              <Switch checked={v.active} onCheckedChange={(x) => setV(i, { active: x })} />
              {v.id ? <span /> : (
                <Button variant="ghost" size="icon-sm" onClick={() => setF({ ...f, variants: f.variants.filter((_, j) => j !== i) })} aria-label="Remove"><Trash2 className="size-4" /></Button>
              )}
            </div>
          ))}
          {f.variants.some((v) => v.id) && <p className="text-xs text-muted-foreground">Saved variants can't be deleted (orders use them) — switch them off instead.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await save({
                  id: f.id, name: f.name, category: f.category || undefined, imageUrl: f.imageUrl || undefined, active: f.active, preOrder: f.preOrder, preOrderFrom: f.preOrderFrom,
                  variants: f.variants.map((v) => ({ ...v, attrs: undefined })),
                })
                toast.success("Product saved")
                onClose()
              } catch (e) {
                toast.error(errMsg(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Save product
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const importProducts = useMutation(api.catalog.importProducts)
  const locations = useQuery(api.team.listLocations)
  const [rows, setRows] = useState<ImportRow[]>([])
  const [format, setFormat] = useState<string>("")
  const [locationId, setLocationId] = useState<string>("none")
  const [busy, setBusy] = useState(false)

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setRows([]); setFormat("") } }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>Import products from CSV</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Use Shopify's <b>Products → Export</b> CSV, or our template. Existing SKUs get their prices updated; new SKUs are created.
          </p>
          <Button
            variant="link" size="sm" className="h-auto p-0"
            onClick={() => {
              const a = document.createElement("a")
              a.href = URL.createObjectURL(new Blob([TEMPLATE_CSV], { type: "text/csv" }))
              a.download = "blackbole-products-template.csv"
              a.click()
            }}
          >
            Download template
          </Button>
          <Input
            type="file" accept=".csv,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              const res = mapProductCsv(await file.text())
              setRows(res.rows)
              setFormat(res.format)
              if (res.format === "unknown") toast.error("This file doesn't look like a Shopify export or our template")
            }}
          />
          {rows.length > 0 && (
            <>
              <div className="rounded-md bg-muted p-3">
                Found <b>{rows.length}</b> SKUs in {new Set(rows.map((r) => r.product)).size} products ({format === "shopify" ? "Shopify export" : "template"}).
              </div>
              <div className="space-y-1.5">
                <Label>Add the CSV stock quantity as opening stock in</Label>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Don't import stock (enter it with Stock in)</SelectItem>
                    {locations?.map((l) => <SelectItem key={l._id} value={l._id}>{l.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button
            disabled={busy || rows.length === 0}
            onClick={async () => {
              setBusy(true)
              let created = 0, updated = 0, skipped = 0
              try {
                for (let i = 0; i < rows.length; i += 100) {
                  const r = await importProducts({
                    rows: rows.slice(i, i + 100),
                    locationId: locationId === "none" ? undefined : (locationId as Id<"locations">),
                  })
                  created += r.created; updated += r.updated; skipped += r.skipped
                }
                toast.success(`Imported: ${created} new, ${updated} updated${skipped ? `, ${skipped} skipped` : ""}`)
                onOpenChange(false)
                setRows([])
              } catch (e) {
                toast.error(errMsg(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Import {rows.length || ""} SKUs
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
