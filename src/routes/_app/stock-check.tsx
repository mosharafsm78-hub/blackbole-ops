import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Guard } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill, Stat } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/stock-check")({
  component: () => (
    <Guard perm="inventory.adjust">
      <StockCheckPage />
    </Guard>
  ),
})

type Filter = "uncounted" | "counted" | "test" | "real" | "all"
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All products" },
  { key: "counted", label: "Counted" },
  { key: "uncounted", label: "Not counted" },
  { key: "test", label: "Fake stock" },
  { key: "real", label: "Real stock" },
]

function StockCheckPage() {
  const summary = useQuery(api.stockCheck.summary)
  const [filter, setFilter] = useState<Filter>("all")
  const [search, setSearch] = useState("")
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const allReal = useMutation(api.stockCheck.markUncountedReal)
  const [confirmReal, setConfirmReal] = useState(false)
  const [realBusy, setRealBusy] = useState(false)

  const reset = () => setCursors([null])
  const searching = search.trim().length > 0
  const shown: Filter = searching ? "all" : filter // a search always looks through every product, so say so on the tabs
  return (
    <div className="space-y-4">
      <PageHeader title="Stock check" sub="Count the pairs really in hand. Whatever the system shows beyond that is marked as fake stock." />
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        <b className="text-foreground">How it works.</b> Type the number of pairs you can physically see for each size. The rest is fake stock:
        it stays on the website and in orders exactly as before, but the target plan and the stock reports treat it as <b>not in hand</b>. When
        a purchase is received the real count rises by itself, so fake stock turns real with nothing more to do.
        <br /><b className="text-foreground">New fake products:</b> type the pairs in “Add fake pairs” and press the button. They are added to the stock
        <i> and</i> marked as fake in one step, with no counting needed. (Adding stock any other way, for example an Inventory adjustment, shows up
        here as “Not counted” so it gets checked.)
      </div>
      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Counted" value={`${summary.counted} / ${summary.lines}`} hint="stock lines" tone={summary.counted === summary.lines ? "green" : "amber"} />
          <Stat label="System shows" value={summary.systemPairs} hint="pairs" />
          <Stat label="Really in hand" value={summary.realPairs} hint="pairs" tone="green" />
          <Stat label="Fake stock" value={summary.fakePairs} hint="pairs" tone={summary.fakePairs > 0 ? "amber" : undefined} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Button key={f.key} size="sm" variant={shown === f.key ? "default" : "outline"} onClick={() => { setFilter(f.key); setSearch(""); reset() }}>{f.label}</Button>
        ))}
        <Input value={search} onChange={(e) => { setSearch(e.target.value); reset() }} placeholder="Search a product…" className="ml-auto w-full sm:w-64" />
      </div>
      {searching && <p className="-mt-2 text-xs text-muted-foreground" data-testid="search-note">Showing every product that matches “{search.trim()}”, counted or not. Clear the search to go back to “{FILTERS.find((f) => f.key === filter)?.label}”.</p>}
      {cursors.map((c, i) => (
        <ProductPage key={`${filter}|${search}|${c ?? "first"}`} filter={filter} search={search} cursor={c} first={i === 0} isLast={i === cursors.length - 1} onMore={(next) => setCursors((cs) => [...cs, next])} />
      ))}
    </div>
  )
}

function ProductPage({ filter, search, cursor, first, isLast, onMore }: { filter: Filter; search: string; cursor: string | null; first: boolean; isLast: boolean; onMore: (c: string) => void }) {
  const data = useQuery(api.stockCheck.list, { filter, search: search || undefined, cursor })
  // A filtered page can come back short because the matching products are spread further down the list: keep looking by itself.
  const more = !!data && data.isDone === false && isLast && data.products.length < 12 && filter !== "all"
  useEffect(() => { if (more && data) onMore(data.cursor) }, [more, data?.cursor]) // eslint-disable-line react-hooks/exhaustive-deps
  if (data === undefined) return <Loading />
  if (data === null) return null
  return (
    <>
      {first && data.products.length === 0 && data.isDone && (
        <Empty title={filter === "uncounted" ? "Everything here has been counted" : "Nothing here"}>{filter === "uncounted" ? "Switch to “All products” to review or change a count." : "Try another filter or search."}</Empty>
      )}
      {data.products.map((p) => <ProductCard key={p.productId} p={p} />)}
      {isLast && !data.isDone && (more ? <Loading /> : <Button variant="outline" onClick={() => onMore(data.cursor)}>Load more products</Button>)}
    </>
  )
}

type Product = NonNullable<ReturnType<typeof useQuery<typeof api.stockCheck.list>>>["products"][number]

function ProductCard({ p }: { p: Product }) {
  const save = useMutation(api.stockCheck.saveCounts)
  const mark = useMutation(api.stockCheck.markProduct)
  const addTest = useMutation(api.stockCheck.addTestStock)
  const skip = useMutation(api.stockCheck.skipProduct)
  const del = useMutation(api.stockCheck.deleteProduct)
  const [confirmDel, setConfirmDel] = useState(false)
  const delSize = useMutation(api.stockCheck.deleteSize)
  const [sizeDel, setSizeDel] = useState<Product["lines"][number] | null>(null)
  const [add, setAdd] = useState<Record<string, string>>({})
  const key = (l: Product["lines"][number]) => `${l.variantId}|${l.locationId}`
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const val = (l: Product["lines"][number]) => draft[key(l)] ?? String(l.real)
  const changed = p.lines.filter((l) => draft[key(l)] !== undefined && Number(draft[key(l)]) !== l.real)
  const toAdd = p.lines.filter((l) => Number(add[key(l)]) > 0).map((l) => ({ variantId: l.variantId, locationId: l.locationId, qty: Number(add[key(l)]) }))
  const needsSave = changed.length > 0 || p.lines.some((l) => !l.counted && draft[key(l)] === undefined) // "all good" still counts as counted

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); setDraft({}); setAdd({}); toast.success(ok) } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <section className="rounded-xl border bg-card p-4" data-testid="stock-check-product">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{p.name}</h2>
          <p className="text-xs text-muted-foreground">System {p.system} · really in hand {p.real}{p.fake > 0 && <> · <b className="text-tone-amber">{p.fake} fake</b></>}{(() => { const c = p.lines.filter((l) => l.countedAt).sort((a, b) => (b.countedAt ?? 0) - (a.countedAt ?? 0))[0]; return c && !p.uncounted ? <> · counted by {c.countedBy ?? "the team"}, {new Date(c.countedAt!).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</> : null })()}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {p.skipped && <Pill tone="gray">Not needed for now</Pill>}
          {p.uncounted ? <Pill tone="amber">Not counted</Pill> : <Pill tone="green">Counted</Pill>}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => mark({ productId: p.productId, mode: "test" }), "Marked as fake stock — none in hand")}>None in hand (all fake)</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => mark({ productId: p.productId, mode: "real" }), "Marked all real")}>All real</Button>
          <Button size="sm" variant="outline" disabled={busy} data-testid="skip-product" onClick={() => void run(() => skip({ productId: p.productId, skip: !p.skipped }), p.skipped ? "Brought back to the count list" : "Hidden from the count list for now")}>
            {p.skipped ? "Bring back" : "Not needed now"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} data-testid="delete-product" className="border-tone-red/40 text-tone-red hover:bg-tone-red/10" onClick={() => setConfirmDel(true)}>Delete product</Button>
        </div>
      </div>
      <AlertDialog open={!!sizeDel} onOpenChange={(o) => { if (!o) setSizeDel(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete size {sizeDel?.title} of “{p.name}”?</AlertDialogTitle>
            <AlertDialogDescription>Only this size is removed, in every warehouse and in Shopify. The other sizes stay. It can't be undone, and it can't be deleted while an open order has it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const l = sizeDel; if (l) void run(() => delSize({ variantId: l.variantId }), `Deleted size ${l.title}`) }}>Delete size</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{p.name}”?</AlertDialogTitle>
            <AlertDialogDescription>It is deleted for good from Ops, the website and Shopify. It can't be undone. If you only want it out of this count list for now, choose “Not needed for now” instead.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void run(() => del({ productId: p.productId }), `Deleted ${p.name}`)}>Delete product</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="mt-3 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[420px] text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr><th className="px-3 py-1.5 text-left font-medium">Size</th><th className="px-3 py-1.5 text-left font-medium">Where</th><th className="px-3 py-1.5 text-right font-medium">System</th><th className="px-3 py-1.5 text-right font-medium">Really in hand</th><th className="px-3 py-1.5 text-right font-medium">Fake</th><th className="px-3 py-1.5 text-right font-medium">Add fake pairs</th><th className="w-10 px-2 py-1.5"></th></tr>
          </thead>
          <tbody>
            {p.lines.map((l) => {
              const real = Number(val(l))
              const fake = Number.isFinite(real) ? Math.max(0, l.available - real) : l.fake
              return (
                <tr key={key(l)} className="border-t">
                  <td className="px-3 py-1.5 font-medium">{l.title}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{l.locationName}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{l.available}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Input type="number" inputMode="numeric" min={0} max={l.available} value={val(l)} onChange={(e) => setDraft({ ...draft, [key(l)]: e.target.value })} className="ml-auto h-8 w-20 text-right tabular-nums" disabled={busy} aria-label={`Real pairs of ${p.name} size ${l.title}`} />
                  </td>
                  <td className={cn("px-3 py-1.5 text-right tabular-nums", fake > 0 && "font-semibold text-tone-amber")}>{fake}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Input type="number" inputMode="numeric" min={0} placeholder="+" value={add[key(l)] ?? ""} onChange={(e) => setAdd({ ...add, [key(l)]: e.target.value })} className="ml-auto h-8 w-20 text-right tabular-nums" disabled={busy} aria-label={`Test pairs to add for ${p.name} size ${l.title}`} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Button size="sm" variant="ghost" disabled={busy} title={`Delete size ${l.title}`} aria-label={`Delete size ${l.title}`} data-testid="delete-size" className="h-8 px-2 text-tone-red hover:bg-tone-red/10" onClick={() => setSizeDel(l)}>✕</Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button
          size="sm" variant="outline" disabled={busy || toAdd.length === 0}
          onClick={() => void run(() => addTest({ items: toAdd }), `Added ${toAdd.reduce((t, i) => t + i.qty, 0)} fake pairs to ${p.name}`)}
        >Add fake pairs</Button>
        <Button size="sm" disabled={busy || !needsSave} onClick={() => void run(() => save({ items: p.lines.map((l) => ({ variantId: l.variantId, locationId: l.locationId, real: Number(val(l)) })) }), `Saved the count for ${p.name}`)}>Save count</Button>
      </div>
    </section>
  )
}
