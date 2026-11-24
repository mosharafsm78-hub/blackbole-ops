import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { Guard } from "@/components/app-shell"
import { Empty, Loading, PageHeader } from "@/components/bits"
import { Input } from "@/components/ui/input"
import { taka } from "@/lib/format"

export const Route = createFileRoute("/_app/outlet-stock")({
  component: () => (
    <Guard perm="orders.view">
      <OutletStockPage />
    </Guard>
  ),
})

function OutletStockPage() {
  const data = useQuery(api.outlets.outletStockList)
  const [outlet, setOutlet] = useState<string>("all")
  const [q, setQ] = useState("")
  const list = useMemo(() => {
    if (!data) return []
    const term = q.trim().toLowerCase()
    return data.products
      .map((p) => ({ ...p, sizes: p.sizes.filter((s) => outlet === "all" || (s.at[outlet] ?? 0) > 0) }))
      .filter((p) => p.sizes.length && (!term || `${p.name} ${p.sizes.map((s) => s.sku).join(" ")}`.toLowerCase().includes(term)))
  }, [data, outlet, q])
  const pairs = list.reduce((n, p) => n + p.sizes.reduce((m, s) => m + (outlet === "all" ? s.total : s.at[outlet] ?? 0), 0), 0)
  return (
    <div className="space-y-4">
      <PageHeader title="Outlet stock" sub="Every shoe and size the outlets hold right now. For customer care: tell the team to bring the pair back before shipping." />
      {!data ? <Loading /> : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {["all", ...data.outlets].map((o) => (
              <button key={o} type="button" onClick={() => setOutlet(o)} className={`rounded-full border px-3 py-1 text-xs ${outlet === o ? "border-foreground bg-foreground text-background" : "hover:bg-accent"}`}>{o === "all" ? "All outlets" : o}</button>
            ))}
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by shoe name (optional)" className="h-8 w-64" />
            <span className="ml-auto text-sm text-muted-foreground">{list.length} shoes · {pairs} pairs</span>
          </div>
          {list.length === 0 ? <Empty title="Nothing in stock at the outlets" /> : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((p) => (
                <div key={p.productId} className="rounded-lg border bg-card p-3" data-testid="outlet-stock-card">
                  <div className="flex items-start gap-3">
                    {p.imageUrl ? <img src={p.imageUrl} alt="" className="size-14 shrink-0 rounded-md border object-cover" /> : <div className="size-14 shrink-0 rounded-md bg-muted" />}
                    <div className="min-w-0 flex-1"><div className="font-medium leading-snug">{p.name}</div><div className="text-xs text-muted-foreground">{taka(p.price)}</div></div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.sizes.map((s) => {
                      const n = outlet === "all" ? s.total : s.at[outlet] ?? 0
                      return (
                        <span key={s.variantId} title={Object.entries(s.at).map(([k, v]) => `${k}: ${v}`).join(" · ")} className="rounded-md border bg-muted/40 px-2 py-1 text-xs">
                          <span className="font-medium">{s.title}</span> <span className="text-tone-violet font-semibold">×{n}</span>
                          {outlet === "all" && data.outlets.length > 1 && <span className="ml-1 text-[10px] text-muted-foreground">{Object.entries(s.at).map(([k, v]) => `${k.split(" ")[0]} ${v}`).join(", ")}</span>}
                        </span>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
