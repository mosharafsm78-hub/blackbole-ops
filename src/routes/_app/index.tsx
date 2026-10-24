import { useMemo, useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { api } from "@/convex/_generated/api"
import { Guard } from "@/components/app-shell"
import { Loading, PageHeader, StatusPill, Stat } from "@/components/bits"
import { startOfDayBD, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/")({
  component: () => (
    <Guard perm="dashboard.view">
      <Dashboard />
    </Guard>
  ),
})

const RANGES = [
  { key: "today", label: "Today", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
]

function Dashboard() {
  const [range, setRange] = useState("7d")
  const days = RANGES.find((r) => r.key === range)!.days
  const { from, to } = useMemo(() => {
    const start = startOfDayBD() - (days - 1) * 86400000
    return { from: start, to: startOfDayBD() + 86400000 - 1 }
  }, [days])
  const stats = useQuery(api.dashboard.stats, { from, to })
  const counts = useQuery(api.orders.counts)

  const queue = [
    { tab: "pending", label: "Pending — call & confirm", tone: "text-tone-amber" },
    { tab: "on_hold", label: "On hold", tone: "text-tone-orange" },
    { tab: "approved", label: "Approved — to pack", tone: "text-tone-blue" },
    { tab: "processing", label: "Processing", tone: "text-tone-violet" },
    { tab: "ready_to_ship", label: "Ready to ship", tone: "text-tone-indigo" },
    { tab: "in_transit", label: "With courier", tone: "text-tone-cyan" },
  ]

  return (
    <div className="space-y-5">
      <PageHeader title="Dashboard" sub="Today's work and how sales are moving.">
        <div className="flex rounded-md border bg-card p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={cn("rounded px-3 py-1 text-sm", range === r.key ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent")}
            >
              {r.label}
            </button>
          ))}
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {queue.map((q) => (
          <Link key={q.tab} to="/orders" search={{ tab: q.tab }} className="rounded-lg border bg-card p-4 transition-colors hover:bg-accent">
            <div className="text-xs font-medium text-muted-foreground">{q.label}</div>
            <div className={cn("mt-1 text-2xl font-semibold tabular-nums", q.tone)}>{counts?.[q.tab] ?? "·"}</div>
          </Link>
        ))}
      </div>

      {stats === undefined || stats === null ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Orders" value={stats.totalOrders} hint="excluding cancelled" />
            <Stat label="Sales" value={taka(stats.totalSales)} />
            <Stat label="Average order" value={taka(stats.avgOrder)} />
            <Stat label="Delivery success" value={stats.deliveryRate === null ? "—" : `${stats.deliveryRate}%`} hint="delivered vs returned" tone={stats.deliveryRate !== null && stats.deliveryRate < 80 ? "red" : "green"} />
            <Stat label="COD due from courier" value={taka(stats.dueCollect)} hint="delivered, not yet paid" />
            <Stat label="Cancelled" value={stats.cancelled} tone={stats.cancelled ? "red" : undefined} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <section className="rounded-lg border bg-card p-4 lg:col-span-2">
              <h2 className="mb-3 text-sm font-semibold">Orders per day</h2>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.daily.map((d) => ({ ...d, label: d.day.slice(5) }))}>
                    <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} stroke="hsl(var(--muted-foreground))" />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} width={28} stroke="hsl(var(--muted-foreground))" />
                    <Tooltip
                      cursor={{ fill: "hsl(var(--muted))" }}
                      contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                    />
                    <Bar dataKey="orders" name="Orders" fill="hsl(var(--brand))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="rounded-lg border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Orders by status (this period)</h2>
              <div className="space-y-1.5">
                {(Object.entries(stats.byStatus) as [string, number][]).sort((a, b) => b[1] - a[1]).map(([s, n]) => (
                  <div key={s} className="flex items-center justify-between text-sm">
                    <StatusPill status={s} />
                    <span className="tabular-nums">{n}</span>
                  </div>
                ))}
                {Object.keys(stats.byStatus).length === 0 && <p className="text-sm text-muted-foreground">No orders in this period.</p>}
              </div>
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-lg border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Orders by source</h2>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground"><tr><th className="pb-2">Source</th><th className="pb-2 text-right">Orders</th><th className="pb-2 text-right">Value</th></tr></thead>
                <tbody className="divide-y">
                  {stats.bySource.map((s) => (
                    <tr key={s.source}><td className="py-1.5">{s.source}</td><td className="py-1.5 text-right tabular-nums">{s.count}</td><td className="py-1.5 text-right tabular-nums">{taka(s.value)}</td></tr>
                  ))}
                </tbody>
              </table>
              {stats.bySource.length === 0 && <p className="text-sm text-muted-foreground">No orders yet.</p>}
            </section>
            <section className="rounded-lg border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Top 10 selling items</h2>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground"><tr><th className="pb-2">Item</th><th className="pb-2 text-right">Qty</th><th className="pb-2 text-right">Value</th></tr></thead>
                <tbody className="divide-y">
                  {stats.topItems.map((i) => (
                    <tr key={i.sku}><td className="py-1.5"><div>{i.name}</div><div className="text-xs text-muted-foreground">{i.sku}</div></td><td className="py-1.5 text-right tabular-nums">{i.qty}</td><td className="py-1.5 text-right tabular-nums">{taka(i.value)}</td></tr>
                  ))}
                </tbody>
              </table>
              {stats.topItems.length === 0 && <p className="text-sm text-muted-foreground">No sales yet.</p>}
            </section>
          </div>
        </>
      )}
    </div>
  )
}
