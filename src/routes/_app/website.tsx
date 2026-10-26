import { useMemo, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useAction, useMutation, useQuery } from "convex/react"
import { ArrowDown, ArrowUp, Download, Globe, Plus, RefreshCw, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { dateTime, errMsg, taka } from "@/lib/format"

export const Route = createFileRoute("/_app/website")({
  validateSearch: (s: Record<string, unknown>) => ({ tab: s.tab === "collections" ? "collections" : "products" }),
  component: () => <WebsiteGuard><WebsitePage /></WebsiteGuard>,
})

function WebsitePage() {
  const { tab } = Route.useSearch()
  const navigate = useNavigate()
  return (
    <div>
      <PageHeader title="Website" sub="Products and collections on blackbole.com. Stock and prices stay live from Ops; other edits go live after the next website rebuild (about 2 minutes after you save).">
        <WebsiteActions />
      </PageHeader>
      <BuildStatus />
      <Tabs value={tab} onValueChange={(v) => navigate({ to: "/website", search: { tab: v as "products" | "collections" } })}>
        <TabsList>
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="collections">Collections</TabsTrigger>
        </TabsList>
        <TabsContent value="products" className="mt-4"><ProductList /></TabsContent>
        <TabsContent value="collections" className="mt-4"><CollectionList /></TabsContent>
      </Tabs>
    </div>
  )
}

function WebsiteActions() {
  const importCatalog = useAction(api.website.importCatalog)
  const rebuild = useMutation(api.website.rebuildNow)
  const [busy, setBusy] = useState<"" | "import" | "build">("")
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setConfirm(true)}>
        <Download className="size-4" /> {busy === "import" ? "Importing…" : "Import website catalog"}
      </Button>
      <Button size="sm" disabled={!!busy} onClick={async () => {
        setBusy("build")
        try {
          const r = await rebuild({})
          toast.success(r.hook ? "Website rebuild started — live in a few minutes" : "No deploy hook set (WEBSITE_DEPLOY_HOOK), nothing to start")
        } catch (e) { toast.error(errMsg(e)) } finally { setBusy("") }
      }}>
        <RefreshCw className="size-4" /> Rebuild website now
      </Button>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader><DialogTitle>Import website catalog</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            Loads every product and collection from the current website and links them to Ops products by SKU. Website text, photos and
            collections are replaced with the website's version; Ops prices and stock are not changed. Products or sizes the website has but
            Ops doesn't are created (no stock). Safe to run again.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button onClick={async () => {
              setConfirm(false); setBusy("import")
              try {
                const r = await importCatalog({})
                toast.success(`Imported ${r.products} products (${r.created} new, ${r.updated} linked), ${r.variantsCreated} new sizes, ${r.collections} collections`)
              } catch (e) { toast.error(errMsg(e)) } finally { setBusy("") }
            }}>Import</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function BuildStatus() {
  const st = useQuery(api.website.status)
  if (!st) return null
  const bits: string[] = []
  if (st.rebuild?.pending) bits.push(`Rebuild queued for ${dateTime(st.rebuild.due)}`)
  if (st.lastBuild) bits.push(`Last rebuild ${dateTime(st.lastBuild.at)}${st.lastBuild.ok ? "" : ` — failed (${st.lastBuild.status || "network"})`}`)
  if (st.lastImport) bits.push(`Last import ${dateTime(st.lastImport.at)}`)
  if (!st.hook) bits.push("Deploy hook not set: rebuilds are skipped")
  if (!bits.length) return null
  return <div className="mb-4 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">{bits.join(" · ")}</div>
}

function Thumb({ url }: { url: string | null }) {
  return url
    ? <img src={url} alt="" loading="lazy" className="size-10 rounded-md border object-cover" />
    : <div className="flex size-10 items-center justify-center rounded-md border bg-muted text-muted-foreground"><Globe className="size-4" /></div>
}

function ProductList() {
  const rows = useQuery(api.website.products)
  const setPublished = useMutation(api.website.setPublished)
  const navigate = useNavigate()
  const [q, setQ] = useState("")
  const [show, setShow] = useState<"all" | "on" | "off">("all")
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (rows ?? []).filter((r) =>
      (show === "all" || (show === "on") === r.published) &&
      (!s || r.title.toLowerCase().includes(s) || r.name.toLowerCase().includes(s) || (r.handle ?? "").includes(s)))
  }, [rows, q, show])
  if (rows === undefined) return <Loading />
  if (rows === null) return null
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Select value={show} onValueChange={(v) => setShow(v as any)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All products</SelectItem>
            <SelectItem value="on">On website</SelectItem>
            <SelectItem value="off">Not on website</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto self-center text-xs text-muted-foreground">{rows.filter((r) => r.published).length} on website · {rows.length} products</div>
      </div>
      {list.length === 0 ? <Empty title="No products">Try another search, or import the website catalog.</Empty> : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-3 font-medium">Product</th><th className="p-3 font-medium">Sizes</th><th className="p-3 text-right font-medium">Price</th><th className="p-3 font-medium">On website</th></tr>
            </thead>
            <tbody className="divide-y">
              {list.map((r) => (
                <tr key={r._id} className="cursor-pointer hover:bg-muted/30" onClick={() => navigate({ to: "/website-product", search: { id: r._id } })}>
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <Thumb url={r.image} />
                      <div className="min-w-0">
                        <div className="font-medium">{r.title} {!r.active && <Pill tone="gray">Inactive in Ops</Pill>}</div>
                        <div className="truncate text-xs text-muted-foreground">{r.handle ? `/products/${r.handle}` : "Not set up for the website yet"}{r.title !== r.name ? ` · Ops: ${r.name}` : ""}</div>
                        {r.partOf && <div className="text-xs text-muted-foreground">Sizes shown on “{r.partOf}”</div>}
                      </div>
                    </div>
                  </td>
                  <td className="p-3 tabular-nums">{r.variants}</td>
                  <td className="p-3 text-right tabular-nums">{r.variants ? (r.minPrice === r.maxPrice ? taka(r.minPrice) : `${taka(r.minPrice)} – ${taka(r.maxPrice)}`) : "—"}</td>
                  <td className="p-3" onClick={(e) => e.stopPropagation()}>
                    <Switch checked={r.published} onCheckedChange={async (on) => {
                      try { await setPublished({ id: r._id, published: on }); toast.success(on ? "Will show on the website after the rebuild" : "Will be hidden after the rebuild") } catch (e) { toast.error(errMsg(e)) }
                    }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------- Collections ----------------
type CollectionsData = NonNullable<ReturnType<typeof useQuery<typeof api.website.collections>>>
type Coll = CollectionsData["collections"][number]

function CollectionList() {
  const data = useQuery(api.website.collections)
  const [edit, setEdit] = useState<Coll | "new" | null>(null)
  if (data === undefined) return <Loading />
  if (data === null) return null
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button size="sm" onClick={() => setEdit("new")}><Plus className="size-4" /> New collection</Button></div>
      {data.collections.length === 0 ? <Empty title="No collections yet">Create one, or import the website catalog.</Empty> : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-3 font-medium">Collection</th><th className="p-3 font-medium">Products</th><th className="p-3" /></tr>
            </thead>
            <tbody className="divide-y">
              {data.collections.map((c) => (
                <tr key={c._id} className="cursor-pointer hover:bg-muted/30" onClick={() => setEdit(c)}>
                  <td className="p-3"><div className="flex items-center gap-3"><Thumb url={c.image ?? null} /><div><div className="font-medium">{c.title}</div><div className="text-xs text-muted-foreground">/collections/{c.handle}</div></div></div></td>
                  <td className="p-3 tabular-nums">{c.productHandles.length}</td>
                  <td className="p-3 text-right"><Button size="sm" variant="ghost">Edit</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <CollectionDialog key={edit === "new" ? "new" : edit._id} coll={edit === "new" ? null : edit} all={data.allProducts} onClose={() => setEdit(null)} />}
    </div>
  )
}

function CollectionDialog({ coll, all, onClose }: { coll: Coll | null; all: CollectionsData["allProducts"]; onClose: () => void }) {
  const save = useMutation(api.website.saveCollection)
  const del = useMutation(api.website.deleteCollection)
  const [f, setF] = useState({
    title: coll?.title ?? "", handle: coll?.handle ?? "", html: coll?.html ?? "", image: coll?.image ?? "",
    seoTitle: coll?.seo?.title ?? "", seoDesc: coll?.seo?.description ?? "",
  })
  const [items, setItems] = useState<string[]>(coll?.productHandles ?? [])
  const [add, setAdd] = useState("")
  const [busy, setBusy] = useState(false)
  const title = new Map<string, { title: string; published: boolean }>(all.map((p: any) => [p.handle, p]))
  const move = (i: number, d: number) => setItems((l) => { const n = [...l]; const j = i + d; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{coll ? `Edit ${coll.title}` : "New collection"}</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label>Name</Label><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
          <div><Label>URL handle</Label><Input value={f.handle} placeholder="made from the name" onChange={(e) => setF({ ...f, handle: e.target.value })} /></div>
          <div className="sm:col-span-2"><Label>Image URL</Label><Input value={f.image} onChange={(e) => setF({ ...f, image: e.target.value })} /></div>
          <div className="sm:col-span-2"><Label>Description (HTML)</Label><Textarea rows={3} className="font-mono text-xs" value={f.html} onChange={(e) => setF({ ...f, html: e.target.value })} /></div>
          <div><Label>SEO title</Label><Input value={f.seoTitle} onChange={(e) => setF({ ...f, seoTitle: e.target.value })} /></div>
          <div><Label>SEO description</Label><Input value={f.seoDesc} onChange={(e) => setF({ ...f, seoDesc: e.target.value })} /></div>
        </div>
        <div>
          <Label>Products (in this order on the website)</Label>
          <div className="mt-1 divide-y rounded-md border">
            {items.length === 0 && <div className="p-3 text-sm text-muted-foreground">No products yet.</div>}
            {items.map((h, i) => (
              <div key={h} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{title.get(h)?.title ?? h}</span>
                {!title.has(h) && <Pill tone="red">Missing</Pill>}
                {title.has(h) && !title.get(h)!.published && <Pill tone="gray">Hidden</Pill>}
                <Button size="icon" variant="ghost" className="size-7" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="size-4" /></Button>
                <Button size="icon" variant="ghost" className="size-7" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="size-4" /></Button>
                <Button size="icon" variant="ghost" className="size-7" onClick={() => setItems(items.filter((x) => x !== h))} aria-label="Remove"><X className="size-4" /></Button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Select value={add} onValueChange={setAdd}>
              <SelectTrigger className="flex-1"><SelectValue placeholder="Add a product…" /></SelectTrigger>
              <SelectContent>
                {all.filter((p) => !items.includes(p.handle)).map((p) => <SelectItem key={p.handle} value={p.handle}>{p.title}{p.published ? "" : " (hidden)"}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" disabled={!add} onClick={() => { setItems([...items, add]); setAdd("") }}>Add</Button>
          </div>
        </div>
        <DialogFooter className="gap-2">
          {coll && <Button variant="ghost" className="mr-auto text-tone-red" disabled={busy} onClick={async () => {
            if (!confirm(`Delete the collection "${coll.title}"? Products are not deleted.`)) return
            setBusy(true)
            try { await del({ id: coll._id }); toast.success("Collection deleted"); onClose() } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
          }}><Trash2 className="size-4" /> Delete</Button>}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            setBusy(true)
            try {
              await save({ id: coll?._id as Id<"webCollections"> | undefined, title: f.title, handle: f.handle, html: f.html, image: f.image.trim() || null, seo: { title: f.seoTitle, description: f.seoDesc }, productHandles: items })
              toast.success("Collection saved"); onClose()
            } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
          }}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
