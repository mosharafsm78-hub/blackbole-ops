import { useEffect, useMemo, useState } from "react"
import { useConvex, useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { CATEGORY_CODES, makeSku, modelCode } from "@/convex/rules"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { parseCsv } from "@/lib/csv"
import { errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Paperclip, Trash2, X } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export type POLine = { variantId: Id<"variants">; sku: string; name: string; title: string; orderedQty: number; unitCost: number; receivedQty?: number; damagedQty?: number }

const TYPES = ["Sandal", "Loafer", "Sneaker", "Casual Shoe", "Formal Shoe", "Boot", "Slipper", "Running Shoe", "Hiking Shoe", "Derby", "Dress", "T-Shirt", "Shirt"]
const FOR = ["Men", "Women", "Kids", "Unisex", ""]
const SIZE_SETS: { label: string; sizes: string[] }[] = [
  { label: "Men 39–44", sizes: ["39", "40", "41", "42", "43", "44"] },
  { label: "Men 39–45", sizes: ["39", "40", "41", "42", "43", "44", "45"] },
  { label: "Women 36–41", sizes: ["36", "37", "38", "39", "40", "41"] },
  { label: "Kids 26–35", sizes: ["26", "27", "28", "29", "30", "31", "32", "33", "34", "35"] },
  { label: "S–XXL", sizes: ["S", "M", "L", "XL", "XXL"] },
  { label: "One size", sizes: ["Free Size"] },
]

/**
 * Product builder: makes the product name and SKUs in BlackBole style.
 * "BlackBole Harbor Shore Sandal For Men - Black" + sizes 39–44 → BB-SH-HSS-BLACK-39 … 44
 */
/** Dropdown that always shows every choice, plus "Type a new one…" for anything not in the list. */
function PickOrType({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  const [typing, setTyping] = useState(false)
  if (typing) return <Input autoFocus value={value} onChange={(e) => onChange(e.target.value)} onBlur={() => setTyping(false)} placeholder="Type a new one" />
  const list = value && !options.includes(value) ? [value, ...options] : options
  return (
    <Select value={value || undefined} onValueChange={(v) => (v === "__new" ? (onChange(""), setTyping(true)) : onChange(v))}>
      <SelectTrigger className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
      <SelectContent>
        {list.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
        <SelectItem value="__new">+ Type a new one…</SelectItem>
      </SelectContent>
    </Select>
  )
}

export function ProductBuilder({ open, onOpenChange, onCreated, preset }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated: (lines: POLine[]) => void
  preset?: { name?: string; color?: string; sizes?: string[]; cost?: number; qty?: Record<string, number> }
}) {
  const create = useMutation(api.purchasing.createProductWithSizes)
  const categories = useQuery(api.purchasing.categories) ?? []
  const [brand, setBrand] = useState("BlackBole")
  const [model, setModel] = useState("")
  const [type, setType] = useState("Sandal")
  const [forWho, setForWho] = useState("Men")
  const [color, setColor] = useState("")
  const [customName, setCustomName] = useState<string | null>(null)
  const [category, setCategory] = useState("Sandals")
  const [sizes, setSizes] = useState<string[]>(SIZE_SETS[0].sizes)
  const [sizeText, setSizeText] = useState("")
  const [qty, setQty] = useState<Record<string, number>>({})
  const [skuOverride, setSkuOverride] = useState<Record<string, string>>({})
  const [prefix, setPrefix] = useState("BB-SH")
  const [code, setCode] = useState<string | null>(null)
  const [price, setPrice] = useState(0)
  const [cost, setCost] = useState(0)
  const [weight, setWeight] = useState(0.5)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setCustomName(preset?.name ? preset.name : null)
    setColor(preset?.color ?? "")
    if (preset?.sizes?.length) setSizes(preset.sizes)
    if (preset?.cost) setCost(preset.cost)
    setQty(preset?.qty ?? {})
    setSkuOverride({})
    setCode(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => { setPrefix(`BB-${CATEGORY_CODES[category] ?? (category.slice(0, 3).toUpperCase() || "SH")}`) }, [category])

  const autoName = [brand.trim(), model.trim(), type.trim()].filter(Boolean).join(" ") + (forWho ? ` For ${forWho}` : "") + (color.trim() ? ` - ${color.trim()}` : "")
  const name = (customName ?? autoName).trim()
  const mCode = code ?? modelCode(customName ? customName.split(" - ")[0] : `${model} ${type}`)
  const skuFor = (size: string) => skuOverride[size] ?? makeSku(prefix, mCode, color, size)

  const addSizes = (list: string[]) => setSizes((s) => [...new Set([...s, ...list.map((x) => x.trim()).filter(Boolean)])])

  async function submit() {
    if (!name) return toast.error("Write the product name")
    if (sizes.length === 0) return toast.error("Add at least one size")
    setBusy(true)
    try {
      const res = await create({
        name, category: category || undefined, price, purchasePrice: cost, weightKg: weight, attrLabel: "Size",
        variants: sizes.map((s) => ({ title: s, sku: skuFor(s) })),
      })
      onCreated(res.variants.map((v) => ({ variantId: v.variantId, sku: v.sku, name: res.name, title: v.title, orderedQty: qty[v.title] ?? 0, unitCost: cost })))
      toast.success(`Created ${res.name} with ${res.variants.length} sizes`)
      onOpenChange(false)
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New product</DialogTitle>
          <DialogDescription>Fill the parts — the name and SKUs are made for you in BlackBole style. You can edit anything.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-5">
          <div className="space-y-1.5"><Label>Brand</Label><Input value={brand} onChange={(e) => { setBrand(e.target.value); setCustomName(null) }} /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Model name</Label><Input value={model} onChange={(e) => { setModel(e.target.value); setCustomName(null) }} placeholder="e.g. Harbor Shore" autoFocus /></div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <PickOrType value={type} options={TYPES} onChange={(v) => { setType(v); setCustomName(null) }} />
          </div>
          <div className="space-y-1.5">
            <Label>For</Label>
            <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={forWho} onChange={(e) => { setForWho(e.target.value); setCustomName(null) }}>
              {FOR.map((f) => <option key={f} value={f}>{f || "—"}</option>)}
            </select>
          </div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Color</Label><Input value={color} onChange={(e) => { setColor(e.target.value); setCustomName(null) }} placeholder="e.g. Black" /></div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label>Category</Label>
            <PickOrType value={category} options={[...new Set([...Object.keys(CATEGORY_CODES), ...categories])].sort()} onChange={setCategory} />
          </div>
        </div>

        <div className="rounded-md border bg-muted/40 p-3">
          <Label className="text-xs text-muted-foreground">Product name</Label>
          <Input className="mt-1 font-medium" value={customName ?? autoName} onChange={(e) => setCustomName(e.target.value)} data-testid="pb-name" />
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1.5"><Label>Selling price (MRP)</Label><Input type="number" value={price} onChange={(e) => setPrice(Number(e.target.value) || 0)} /></div>
          <div className="space-y-1.5"><Label>Purchase cost</Label><Input type="number" value={cost} onChange={(e) => setCost(Number(e.target.value) || 0)} /></div>
          <div className="space-y-1.5"><Label>Weight (kg)</Label><Input type="number" step="0.1" value={weight} onChange={(e) => setWeight(Number(e.target.value) || 0)} /></div>
          <div className="space-y-1.5"><Label>SKU start</Label><div className="flex gap-1"><Input value={prefix} onChange={(e) => setPrefix(e.target.value)} /><Input value={mCode} onChange={(e) => setCode(e.target.value.toUpperCase())} className="w-20" /></div></div>
        </div>

        <div className="space-y-2">
          <Label>Sizes</Label>
          <div className="flex flex-wrap gap-1.5">
            {SIZE_SETS.map((s) => (
              <Button key={s.label} type="button" size="xs" variant="outline" onClick={() => setSizes(s.sizes)}>{s.label}</Button>
            ))}
            <Input className="h-7 w-40 text-xs" value={sizeText} onChange={(e) => setSizeText(e.target.value)} placeholder="Add: 45, 46" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSizes(sizeText.split(/[,\s]+/)); setSizeText("") } }} />
          </div>
          <div className="divide-y rounded-md border">
            {sizes.map((s) => (
              <div key={s} className="flex items-center gap-2 p-2 text-sm">
                <span className="w-16 font-medium">{s}</span>
                <Input className="h-8 flex-1 font-mono text-xs" value={skuFor(s)} onChange={(e) => setSkuOverride({ ...skuOverride, [s]: e.target.value.toUpperCase() })} />
                <label className="flex items-center gap-1 text-xs">Qty<Input type="number" className="h-8 w-20" value={qty[s] ?? 0} onChange={(e) => setQty({ ...qty, [s]: Math.max(0, Number(e.target.value) || 0) })} /></label>
                <Button type="button" size="xs" variant="ghost" onClick={() => setSizes(sizes.filter((x) => x !== s))}>Remove</Button>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Total {Object.entries(qty).filter(([k]) => sizes.includes(k)).reduce((t, [, n]) => t + n, 0)} pcs · {taka(cost * Object.entries(qty).filter(([k]) => sizes.includes(k)).reduce((t, [, n]) => t + n, 0))}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create product & add to list"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Parsed = { sku?: string; name?: string; size?: string; color?: string; qty: number; cost: number }

function pickColumns(header: string[]) {
  const h = header.map((x) => x.toLowerCase().trim())
  const find = (re: RegExp) => h.findIndex((x) => re.test(x))
  return {
    sku: find(/\b(sku|code|article|style|item no|model no)\b/),
    name: find(/(product|name|item|description|desc)/),
    size: find(/\bsize\b/),
    color: find(/colou?r/),
    qty: find(/(qty|quantity|pcs|pairs|units|order)/),
    cost: find(/(cost|unit price|price|rate|fob|amount per)/),
  }
}

async function readRows(file: File): Promise<string[][]> {
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const XLSX = await import("xlsx")
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    return (XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as unknown[][]).map((r) => r.map((c) => String(c ?? "")))
  }
  return parseCsv(await file.text())
}

/** Upload the supplier's order list / packing list (Excel or CSV). Known products are matched; new ones can be created in one click. */
export function UploadList({ open, onOpenChange, onAdd, onCreateNew }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onAdd: (lines: POLine[]) => void
  onCreateNew: (preset: { name?: string; color?: string; sizes?: string[]; cost?: number; qty?: Record<string, number> }) => void
}) {
  const convex = useConvex()
  const [rows, setRows] = useState<Parsed[]>([])
  const [matches, setMatches] = useState<({ variantId: Id<"variants">; sku: string; name: string; title: string; purchasePrice: number } | null)[]>([])
  const [fileName, setFileName] = useState("")

  useEffect(() => { if (!open) { setRows([]); setMatches([]); setFileName("") } }, [open])

  async function onFile(f: File) {
    try {
      const all = (await readRows(f)).filter((r) => r.some((c) => c.trim()))
      const headerIdx = all.findIndex((r) => { const c = pickColumns(r); return c.qty >= 0 && (c.sku >= 0 || c.name >= 0) })
      if (headerIdx < 0) return toast.error("Couldn't find the columns. The list needs a Qty column and a SKU or Product name column.")
      const c = pickColumns(all[headerIdx])
      const num = (s?: string) => Number(String(s ?? "").replace(/[^\d.]/g, "")) || 0
      const parsed = all.slice(headerIdx + 1).map((r) => ({
        sku: c.sku >= 0 ? r[c.sku]?.trim() || undefined : undefined,
        name: c.name >= 0 ? r[c.name]?.trim() || undefined : undefined,
        size: c.size >= 0 ? r[c.size]?.trim() || undefined : undefined,
        color: c.color >= 0 ? r[c.color]?.trim() || undefined : undefined,
        qty: num(r[c.qty]),
        cost: c.cost >= 0 ? num(r[c.cost]) : 0,
      })).filter((r) => r.qty > 0 && (r.sku || r.name))
      setFileName(f.name)
      setRows(parsed)
      setMatches(await convex.query(api.purchasing.matchLines, { lines: parsed.map(({ sku, name, size, color }) => ({ sku, name, size, color })) }))
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const matched = rows.map((r, i) => ({ r, m: matches[i] })).filter((x) => x.m)
  const missing = rows.map((r, i) => ({ r, m: matches[i] })).filter((x) => !x.m)
  // group unmatched lines into products (same name + color), so each can be created with all its sizes at once
  const groups = useMemo(() => {
    const g = new Map<string, { name?: string; color?: string; sizes: string[]; qty: Record<string, number>; cost: number }>()
    for (const { r } of missing) {
      const k = `${r.name ?? r.sku}|${r.color ?? ""}`
      const e = g.get(k) ?? { name: r.name ?? r.sku, color: r.color, sizes: [], qty: {}, cost: r.cost }
      const size = r.size ?? "Free Size"
      if (!e.sizes.includes(size)) e.sizes.push(size)
      e.qty[size] = (e.qty[size] ?? 0) + r.qty
      g.set(k, e)
    }
    return [...g.values()]
  }, [missing])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Upload supplier list</DialogTitle>
          <DialogDescription>Excel (.xlsx) or CSV with columns like: SKU, Product name, Color, Size, Qty, Unit cost. Header names can vary.</DialogDescription>
        </DialogHeader>
        <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }} data-testid="po-upload" />
        {fileName && (
          <div className="space-y-3 text-sm">
            <p>{fileName}: <b>{rows.length}</b> lines · <span className="text-tone-green">{matched.length} found</span> · <span className={missing.length ? "text-tone-red" : ""}>{missing.length} new</span></p>
            {matched.length > 0 && (
              <div className="max-h-56 divide-y overflow-auto rounded-md border">
                {matched.map(({ r, m }, i) => (
                  <div key={i} className="flex justify-between gap-2 p-2"><span className="truncate">{m!.name} · {m!.title} <span className="text-xs text-muted-foreground">{m!.sku}</span></span><span className="whitespace-nowrap">{r.qty} × {taka(r.cost || m!.purchasePrice)}</span></div>
                ))}
              </div>
            )}
            {groups.length > 0 && (
              <div className="space-y-2 rounded-md border border-dashed p-3">
                <p className="font-medium">New products in the list (not in the system yet)</p>
                {groups.map((g, i) => (
                  <div key={i} className="flex items-center justify-between gap-2">
                    <span className="truncate">{g.name}{g.color ? ` - ${g.color}` : ""} <span className="text-xs text-muted-foreground">sizes {g.sizes.join(", ")}</span></span>
                    <Button size="xs" variant="outline" onClick={() => onCreateNew({ name: g.name && g.color ? `${g.name} - ${g.color}` : g.name, color: g.color, sizes: g.sizes, cost: g.cost, qty: g.qty })}>Create product</Button>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">After creating, upload the file again — the lines will be found.</p>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button disabled={matched.length === 0} onClick={() => {
            onAdd(matched.map(({ r, m }) => ({ variantId: m!.variantId, sku: m!.sku, name: m!.name, title: m!.title, orderedQty: r.qty, unitCost: r.cost || m!.purchasePrice })))
            onOpenChange(false)
          }}>Add {matched.length} found lines</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SupplierDialog({ supplier, open, onOpenChange, onSaved, onDeleted }: {
  supplier?: { _id: Id<"suppliers">; name: string; contactPerson?: string; phone?: string; email?: string; address?: string; note?: string; openingDue?: number; active: boolean } | null
  open: boolean
  onOpenChange: (o: boolean) => void
  onSaved?: (id: Id<"suppliers">) => void
  onDeleted?: (movedTo?: Id<"suppliers">) => void
}) {
  const save = useMutation(api.purchasing.saveSupplier)
  const del = useMutation(api.purchasing.deleteSupplier)
  const all = useQuery(api.purchasing.listSuppliers) ?? []
  const me = all.find((x) => x._id === supplier?._id)
  const hasHistory = !!me && (me.poCount > 0 || me.paid !== 0 || (me.opening ?? 0) !== 0)
  const [confirmDel, setConfirmDel] = useState(false)
  const [moveTo, setMoveTo] = useState("")
  useEffect(() => { if (open) { setConfirmDel(false); setMoveTo("") } }, [open])
  const [f, setF] = useState({ name: "", contactPerson: "", phone: "", email: "", address: "", note: "", openingDue: 0, active: true })
  useEffect(() => {
    if (open) setF({ name: supplier?.name ?? "", contactPerson: supplier?.contactPerson ?? "", phone: supplier?.phone ?? "", email: supplier?.email ?? "", address: supplier?.address ?? "", note: supplier?.note ?? "", openingDue: supplier?.openingDue ?? 0, active: supplier?.active ?? true })
  }, [open, supplier])
  const set = (k: keyof typeof f, v: string | boolean | number) => setF((x) => ({ ...x, [k]: v }))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{supplier ? "Edit supplier" : "New supplier"}</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2"><Label>Factory name</Label><Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Guangzhou Shoe Factory / Own factory" autoFocus /></div>
          <div className="space-y-1.5"><Label>Representative name</Label><Input value={f.contactPerson} onChange={(e) => set("contactPerson", e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Phone / WeChat</Label><Input value={f.phone} onChange={(e) => set("phone", e.target.value)} /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Email</Label><Input value={f.email} onChange={(e) => set("email", e.target.value)} /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Address</Label><Input value={f.address} onChange={(e) => set("address", e.target.value)} /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Note</Label><Textarea value={f.note} onChange={(e) => set("note", e.target.value)} rows={2} /></div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Previous due (what we already owed before this system)</Label>
            <Input type="number" value={f.openingDue} onChange={(e) => set("openingDue", Number(e.target.value) || 0)} />
          </div>
          <label className="flex items-center gap-2 text-sm"><Switch checked={f.active} onCheckedChange={(v) => set("active", v)} /> Active</label>
        </div>
        {supplier && confirmDel && (
          <div className="space-y-2 rounded-md border border-tone-red/40 bg-tone-red-bg/40 p-3 text-sm">
            <div className="font-semibold text-tone-red">Delete "{supplier.name}"?</div>
            {hasHistory ? (
              <>
                <p className="text-xs text-muted-foreground">This supplier has purchases or payments. They will be moved to the supplier you choose (nothing is lost).</p>
                <Select value={moveTo} onValueChange={setMoveTo}>
                  <SelectTrigger className="w-full bg-background"><SelectValue placeholder="Move purchases & payments to…" /></SelectTrigger>
                  <SelectContent>{all.filter((x) => x._id !== supplier._id).map((x) => <SelectItem key={x._id} value={x._id}>{x.name}</SelectItem>)}</SelectContent>
                </Select>
              </>
            ) : <p className="text-xs text-muted-foreground">No purchases or payments use this supplier, so it can be removed safely.</p>}
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" disabled={hasHistory && !moveTo} onClick={async () => {
                try {
                  await del({ id: supplier._id, moveTo: moveTo ? (moveTo as Id<"suppliers">) : undefined })
                  toast.success("Supplier deleted")
                  onDeleted?.(moveTo ? (moveTo as Id<"suppliers">) : undefined)
                  onOpenChange(false)
                } catch (e) { toast.error(errMsg(e)) }
              }}>Yes, delete</Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmDel(false)}>Keep it</Button>
            </div>
          </div>
        )}
        <DialogFooter className="gap-2">
          {supplier && !confirmDel && <Button variant="outline" className="mr-auto text-tone-red" onClick={() => setConfirmDel(true)}><Trash2 className="size-4" /> Delete supplier</Button>}
          <Button onClick={async () => {
            try {
              const id = await save({ id: supplier?._id, name: f.name, contactPerson: f.contactPerson || undefined, phone: f.phone || undefined, email: f.email || undefined, address: f.address || undefined, note: f.note || undefined, openingDue: f.openingDue || undefined, active: f.active })
              toast.success("Supplier saved")
              onSaved?.(id)
              onOpenChange(false)
            } catch (e) { toast.error(errMsg(e)) }
          }}>Save supplier</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const PO_TONE: Record<string, string> = {
  draft: "bg-tone-gray-bg text-tone-gray", ordered: "bg-tone-blue-bg text-tone-blue", shipped: "bg-tone-violet-bg text-tone-violet",
  partial: "bg-tone-amber-bg text-tone-amber", received: "bg-tone-green-bg text-tone-green", cancelled: "bg-tone-red-bg text-tone-red",
}

export function POStatus({ status, label }: { status: string; label: string }) {
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap", PO_TONE[status] ?? PO_TONE.draft)}>{label}</span>
}

export const poCode = (n: number) => `PO-${String(n).padStart(4, "0")}`

export type Slip = { slipId: Id<"_storage">; slipName: string } | null

/** Upload a bank slip / bKash screenshot / money receipt (image or PDF). Uploads as soon as a file is chosen. */
export function SlipPicker({ value, onChange, compact, label, required, onType }: { value: Slip; onChange: (s: Slip) => void; compact?: boolean; label?: string; required?: boolean; onType?: (t: string) => void }) {
  const getUrl = useMutation(api.purchasing.slipUploadUrl)
  const [busy, setBusy] = useState(false)
  const pick = async (f: File | undefined) => {
    if (!f) return
    if (f.size > 10 * 1024 * 1024) return toast.error("File is larger than 10 MB")
    setBusy(true)
    try {
      const url = await getUrl()
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f })
      if (!r.ok) throw new Error("Upload failed")
      const { storageId } = await r.json()
      onType?.(f.type || "application/octet-stream")
      onChange({ slipId: storageId, slipName: f.name })
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <div className={cn("flex items-center gap-2 text-xs", compact ? "" : "rounded-md border border-dashed p-2", required && !value && "border-tone-red/60 bg-tone-red-bg/30")}>
      {value ? (
        <>
          <Paperclip className="size-3.5 shrink-0 text-tone-green" />
          <span className="min-w-0 flex-1 truncate font-medium text-tone-green">{value.slipName}</span>
          <button type="button" className="text-muted-foreground hover:text-tone-red" onClick={() => onChange(null)} aria-label="Remove slip"><X className="size-3.5" /></button>
        </>
      ) : (
        <label className="flex flex-1 cursor-pointer items-center gap-2 text-muted-foreground hover:text-foreground">
          <Paperclip className="size-3.5 shrink-0" />
          {busy ? "Uploading…" : label ?? `Attach bank slip / bKash screenshot / receipt${required ? " (required)" : ""}`}
          <input type="file" accept="image/*,application/pdf" className="hidden" disabled={busy} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = "" }} />
        </label>
      )}
    </div>
  )
}

/** On a saved payment: show the slip, or a small button to attach one later. */
export function SlipLink({ paymentId, url }: { paymentId: Id<"supplierPayments">; url?: string | null }) {
  const attach = useMutation(api.purchasing.attachSlip)
  const getUrl = useMutation(api.purchasing.slipUploadUrl)
  const [busy, setBusy] = useState(false)
  if (url) return <a href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-xs font-medium text-tone-blue hover:underline"><Paperclip className="size-3" /> Slip</a>
  return (
    <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={(e) => e.stopPropagation()}>
      <Paperclip className="size-3" /> {busy ? "Uploading…" : "Add slip"}
      <input type="file" accept="image/*,application/pdf" className="hidden" disabled={busy} onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = ""
        if (!f) return
        setBusy(true)
        try {
          const up = await getUrl()
          const r = await fetch(up, { method: "POST", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f })
          if (!r.ok) throw new Error("Upload failed")
          const { storageId } = await r.json()
          await attach({ id: paymentId, slipId: storageId, slipName: f.name })
          toast.success("Slip attached")
        } catch (err) { toast.error(errMsg(err)) } finally { setBusy(false) }
      }} />
    </label>
  )
}
