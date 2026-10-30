import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Guard } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill, Stat } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/stock-check")({
  component: () => (
    <Guard perm="inventory.adjust">
      <StockCheckPage />
    </Guard>
  ),
})

type Filter = "uncounted" | "test" | "all"
const FILTERS: { key: Filter; label: string }[] = [
  { key: "uncounted", label: "Not counted yet" },
  { key: "test", label: "Has test stock" },
  { key: "all", label: "All products" },
]

function StockCheckPage() {
  const summary = useQuery(api.stockCheck.summary)
  const [filter, setFilter] = useState<Filter>("uncounted")
  const [search, setSearch] = useState("")
  const [cursors, setCursors] = useState<(string | null)[]>([null])

  const reset = () => setCursors([null])
  return (
    <div className="space-y-4">
      <PageHeader title="Stock check" sub="Count the pairs really in hand. Whatever the system shows beyond that is marked as test stock." />
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        <b className="text-foreground">How it works.</b> Type the number of pairs you can physically see for each size. The rest is test stock:
        it stays on the website and in orders exactly as before, but the target plan and the stock reports treat it as <b>not in hand</b>. When
        a purchase is received the real count rises by itself, so test stock turns real with nothing more to do.
        <br /><b className="text-foreground">New test products:</b> type the pairs in “Add test pairs” and press the button. They are added to the stock
        <i> and</i> marked as test in one step, with no counting needed. (Adding stock any other way, for example an Inventory adjustment, shows up
        here as “Not counted” so it gets checked.)
      </div>
      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Counted" value={`${summary.counted} / ${summary.lines}`} hint="stock lines" tone={summary.counted === summary.lines ? "green" : "amber"} />
          <Stat label="System shows" value={summary.systemPairs} hint="pairs" />
          <Stat label="Really in hand" value={summary.realPairs} hint="pairs" tone="green" />
          <Stat label="Test (fake) stock" value={summary.fakePairs} hint="pairs" tone={summary.fakePairs > 0 ? "amber" : undefined} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Button key={f.key} size="sm" variant={filter === f.key ? "default" : "outline"} onClick={() => { setFilter(f.key); reset() }}>{f.label}</Button>
        ))}
        <Input value={search} onChange={(e) => { setSearch(e.target.value); reset() }} placeholder="Search a product…" className="ml-auto w-full sm:w-64" />
      </div>
      {cursors.map((c, i) => (
        <ProductPage key={`${filter}|${search}|${c ?? "first"}`} filter={filter} search={search} cursor={c} first={i === 0} isLast={i === cursors.length - 1} onMore={(next) => setCursors((cs) => [...cs, next])} />
      ))}
    </div>
  )
}

function ProductPage({ filter, search, cursor, first, isLast, onMore }: { filter: Filter; search: string; cursor: string | null; first: boolean; isLast: boolean; onMore: (c: string) => void }) {
  const data = useQuery(api.stockCheck.list, { filter, search: search || undefined, cursor })
  if (data === undefined) return <Loading />
  if (data === null) return null
  return (
    <>
      {first && data.products.length === 0 && data.isDone && (
        <Empty title={filter === "uncounted" ? "Everything here has been counted" : "Nothing here"}>{filter === "uncounted" ? "Switch to “All products” to review or change a count." : "Try another filter or search."}</Empty>
      )}
      {data.products.map((p) => <ProductCard key={p.productId} p={p} />)}
      {isLast && !data.isDone && <Button variant="outline" onClick={() => onMore(data.cursor)}>Load more products</Button>}
    </>
  )
}

type Product = NonNullable<ReturnType<typeof useQuery<typeof api.stockCheck.list>>>["products"][number]

function ProductCard({ p }: { p: Product }) {
  const save = useMutation(api.stockCheck.saveCounts)
  const mark = useMutation(api.stockCheck.markProduct)
  const addTest = useMutation(api.stockCheck.addTestStock)
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
          <p className="text-xs text-muted-foreground">System {p.system} · really in hand {p.real}{p.fake > 0 && <> · <b className="text-tone-amber">{p.fake} test</b></>}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {p.uncounted ? <Pill tone="amber">Not counted</Pill> : <Pill tone="green">Counted</Pill>}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => mark({ productId: p.productId, mode: "test" }), "Marked as test stock — none in hand")}>None in hand (all test)</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => mark({ productId: p.productId, mode: "real" }), "Marked all real")}>All real</Button>
        </div>
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[420px] text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr><th className="px-3 py-1.5 text-left font-medium">Size</th><th className="px-3 py-1.5 text-left font-medium">Where</th><th className="px-3 py-1.5 text-right font-medium">System</th><th className="px-3 py-1.5 text-right font-medium">Really in hand</th><th className="px-3 py-1.5 text-right font-medium">Test</th><th className="px-3 py-1.5 text-right font-medium">Add test pairs</th></tr>
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
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button
          size="sm" variant="outline" disabled={busy || toAdd.length === 0}
          onClick={() => void run(() => addTest({ items: toAdd }), `Added ${toAdd.reduce((t, i) => t + i.qty, 0)} test pairs to ${p.name}`)}
        >Add test pairs</Button>
        <Button size="sm" disabled={busy || !needsSave} onClick={() => void run(() => save({ items: p.lines.map((l) => ({ variantId: l.variantId, locationId: l.locationId, real: Number(val(l)) })) }), `Saved the count for ${p.name}`)}>Save count</Button>
      </div>
    </section>
  )
}
