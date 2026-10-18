import { useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { CUSTOMER_TAGS } from "@/convex/rules"
import { Guard } from "@/components/app-shell"
import { ContactButtons, Empty, Loading, PageHeader, TagPill } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { dateOnly, taka } from "@/lib/format"

export const Route = createFileRoute("/_app/customers")({
  component: () => (
    <Guard perm="orders.view">
      <Customers />
    </Guard>
  ),
})

function Customers() {
  const [q, setQ] = useState("")
  const [debounced, setDebounced] = useState("")
  const [tag, setTag] = useState<string | undefined>()
  const [limit, setLimit] = useState(100)
  const data = useQuery(api.customers.list, { search: debounced || undefined, tag, limit })

  return (
    <div>
      <PageHeader title="Customers" sub={data ? `${data.total} customers, created automatically from orders` : undefined} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <form onSubmit={(e) => { e.preventDefault(); setDebounced(q.trim()) }} className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or phone" className="w-64" />
          <Button type="submit" variant="outline" size="sm">Search</Button>
        </form>
        <div className="flex gap-1">
          <Button size="sm" variant={!tag ? "default" : "outline"} onClick={() => setTag(undefined)}>All</Button>
          {CUSTOMER_TAGS.map((t) => (
            <Button key={t} size="sm" variant={tag === t ? "default" : "outline"} onClick={() => setTag(t)}>{t}</Button>
          ))}
        </div>
      </div>
      {data === undefined || data === null ? <Loading /> : data.rows.length === 0 ? (
        <Empty title="No customers found">Customers appear here when their first order comes in.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Customer</th><th className="p-3 font-medium">Contact</th><th className="p-3 font-medium">Location</th>
                <th className="p-3 text-right font-medium">Orders</th><th className="p-3 text-right font-medium">Delivered</th><th className="p-3 text-right font-medium">Returned</th>
                <th className="p-3 text-right font-medium">Spent</th><th className="p-3 font-medium">Last order</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.rows.map((c) => (
                <tr key={c._id} className="hover:bg-muted/30">
                  <td className="p-3">
                    <Link to="/customer" search={{ id: c._id }} className="font-medium text-tone-blue hover:underline">{c.name}</Link>
                    <div className="mt-1 flex items-center gap-1.5"><TagPill tag={c.tag} /><span className="text-xs text-muted-foreground">C-{c.code}{c.source ? ` · ${c.source}` : ""}</span></div>
                  </td>
                  <td className="p-3"><div className="tabular-nums">{c.phone}</div><div className="mt-1"><ContactButtons phone={c.phone} /></div></td>
                  <td className="max-w-64 p-3 text-xs">{c.city && <div className="font-medium">{c.city}</div>}<div className="line-clamp-2 text-muted-foreground">{c.address}</div></td>
                  <td className="p-3 text-right tabular-nums">{c.orderCount}</td>
                  <td className="p-3 text-right tabular-nums">{c.deliveredCount}</td>
                  <td className={`p-3 text-right tabular-nums ${c.returnedCount ? "text-tone-red" : ""}`}>{c.returnedCount}</td>
                  <td className="p-3 text-right tabular-nums">{taka(c.totalSpent)}</td>
                  <td className="p-3 text-xs">{dateOnly(c.lastOrderAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.hasMore && <div className="border-t p-3 text-center"><Button variant="outline" size="sm" onClick={() => setLimit((l) => l + 100)}>Load more</Button></div>}
        </div>
      )}
    </div>
  )
}
