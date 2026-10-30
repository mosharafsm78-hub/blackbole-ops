import { useEffect, useMemo, useState } from "react"
import { Link, createFileRoute, useParams } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ArrowLeft, Check, Pencil, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Guard, useCan } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill, Stat } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/products/$productId")({
  component: () => (
    <Guard perm="orders.view">
      <ProductDetailPage />
    </Guard>
  ),
})

function ProductDetailPage() {
  const { productId } = useParams({ from: "/_app/products/$productId" })
  const can = useCan()
  const product = useQuery(api.catalog.productDetail, { id: productId })
  const [activeId, setActiveId] = useState<string | null>(null)

  // Keep a valid size tab selected as variants load / change.
  useEffect(() => {
    if (!product) return
    if (activeId && product.variants.some((v) => v._id === activeId)) return
    setActiveId(product.variants[0]?._id ?? null)
  }, [product, activeId])

  if (product === undefined) return <Loading />
  if (product === null) {
    return (
      <div className="mx-auto max-w-3xl">
        <Empty title="Product not found">This product may have been removed, or the link is out of date.</Empty>
        <div className="mt-3 text-center">
          <Link to="/products" className="text-sm font-medium text-tone-blue hover:underline">← Back to Products</Link>
        </div>
      </div>
    )
  }

  const active = product.variants.find((v) => v._id === activeId) ?? product.variants[0] ?? null
  const totalAvailable = product.variants.reduce((s, v) => s + v.stock.available, 0)

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link to="/products" className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Products
      </Link>

      <PageHeader
        title={product.name}
        sub={<span className="font-mono text-xs">{product._id}</span>}
      >
        {product.active ? <Pill tone="green">Active</Pill> : <Pill tone="gray">Inactive</Pill>}
      </PageHeader>

      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <div className="space-y-3">
          {product.imageUrl
            ? <img src={product.imageUrl} alt="" className="w-full rounded-lg border object-cover" />
            : <div className="aspect-square w-full rounded-lg bg-muted" />}
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Sizes" value={product.variants.length} />
            <Stat label="In stock" value={totalAvailable} tone={totalAvailable <= 0 ? "red" : undefined} />
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <div className="text-xs font-medium text-muted-foreground">Category</div>
            <div className="text-sm">{product.category || "—"}</div>
            {product.description && <p className="mt-2 text-sm text-muted-foreground">{product.description}</p>}
          </div>

          {/* Size variant tabs */}
          <div className="rounded-lg border bg-card">
            <div className="flex flex-wrap gap-1 border-b p-2">
              {product.variants.length === 0 && <span className="p-2 text-sm text-muted-foreground">No sizes yet.</span>}
              {product.variants.map((v) => {
                const on = v._id === active?._id
                return (
                  <button
                    key={v._id}
                    type="button"
                    onClick={() => setActiveId(v._id)}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition",
                      on ? "bg-foreground text-background" : "hover:bg-muted",
                      !v.active && "opacity-60",
                    )}
                  >
                    {v.title}
                    <span className={cn("ml-1.5 text-xs tabular-nums", on ? "text-background/70" : "text-muted-foreground")}>
                      {v.stock.available}
                    </span>
                  </button>
                )
              })}
            </div>

            {active && (
              <div className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{active.sku}</span>
                  {active.attrs && <Pill tone="gray">{active.attrs}</Pill>}
                  {!active.active && <Pill tone="gray">Inactive</Pill>}
                  <span className="ml-auto text-sm font-semibold tabular-nums">{taka(active.price)}</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="Available" value={active.stock.available} tone={active.stock.available <= 0 ? "red" : "green"} />
                  <Stat label="Processing" value={active.stock.processing} />
                  <Stat label="In transit" value={active.stock.inTransit} />
                </div>
                {active.warehouses.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    {active.warehouses.map((w) => `${w.locationName}: ${w.available}`).join(" · ")}
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  Internal variant ID <span className="font-mono">{active._id}</span>
                </div>
              </div>
            )}
          </div>

          <FeaturesCard productId={product._id} features={product.features} canEdit={can("products.manage")} />
        </div>
      </div>
    </div>
  )
}

function FeaturesCard({ productId, features, canEdit }: { productId: Id<"products">; features: string[]; canEdit: boolean }) {
  const save = useMutation(api.catalog.saveProductFeatures)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(features.join("\n"))
  const [busy, setBusy] = useState(false)

  const list = useMemo(() => features.filter(Boolean), [features])

  const submit = async () => {
    setBusy(true)
    try {
      await save({ productId, features: text.split("\n").map((l) => l.trim()).filter(Boolean) })
      toast.success("Features saved")
      setEditing(false)
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold">Product features</div>
        {canEdit && !editing && (
          <Button variant="ghost" size="sm" onClick={() => { setText(list.join("\n")); setEditing(true) }}>
            <Pencil className="size-3.5" /> Edit
          </Button>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={"One feature per line, e.g.\nWater-resistant synthetic upper\nCushioned EVA footbed"} rows={5} />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void submit()}><Check className="size-3.5" /> Save</Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}><X className="size-3.5" /> Cancel</Button>
          </div>
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No features yet.{canEdit ? " Click Edit to add bulleted features." : ""}</p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {list.map((f, i) => <li key={i}>{f}</li>)}
        </ul>
      )}
    </div>
  )
}
