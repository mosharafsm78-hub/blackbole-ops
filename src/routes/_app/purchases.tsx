import { useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { Plus, Truck, Users } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { PO_STATUS_LABEL } from "@/convex/rules"
import { Guard, useCan } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Stat } from "@/components/bits"
import { POStatus, poCode } from "@/components/purchase-parts"
import { Button } from "@/components/ui/button"
import { dateOnly, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/purchases")({
  component: () => (
    <Guard perm="inventory.receive">
      <Purchases />
    </Guard>
  ),
})

const TABS = [
  { key: "", label: "All" },
  { key: "open", label: "Open" },
  { key: "draft", label: "Draft" },
  { key: "ordered", label: "Ordered" },
  { key: "shipped", label: "On the way" },
  { key: "partial", label: "Partly received" },
  { key: "received", label: "Received" },
  { key: "cancelled", label: "Cancelled" },
]

function Purchases() {
  const can = useCan()
  const navigate = useNavigate()
  const [tab, setTab] = useState("open")
  const rows = useQuery(api.purchasing.listPOs, { status: tab || undefined })
  const all = useQuery(api.purchasing.listPOs, {})
  const open = (all ?? []).filter((p) => ["ordered", "shipped", "partial"].includes(p.status))
  const onTheWay = (all ?? []).filter((p) => p.status === "shipped")
  const due = (all ?? []).filter((p) => p.status !== "cancelled" && p.status !== "draft").reduce((t, p) => t + p.due, 0)

  return (
    <div>
      <PageHeader title="Purchases & stock in" sub="Order from suppliers, track shipments, receive stock into the warehouse and pay suppliers.">
        <Button variant="outline" size="sm" asChild><Link to="/suppliers"><Users className="size-4" /> Suppliers</Link></Button>
        {can("purchases.manage") && <Button size="sm" onClick={() => navigate({ to: "/purchase", search: { id: "new" } })}><Plus className="size-4" /> New purchase</Button>}
      </PageHeader>

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label="Open purchases" value={open.length} />
        <Stat label="On the way" value={<span className="inline-flex items-center gap-1.5"><Truck className="size-4" />{onTheWay.reduce((t, p) => t + p.orderedUnits - p.receivedUnits - p.damagedUnits, 0)} pcs</span>} hint={`${onTheWay.length} shipments`} />
        <Stat label="Waiting to receive" value={`${open.reduce((t, p) => t + p.orderedUnits - p.receivedUnits - p.damagedUnits, 0)} pcs`} />
        <Link to="/suppliers" className="block"><Stat label="We owe suppliers →" value={taka(due)} tone={due > 0 ? "red" : undefined} hint="Open supplier accounts" /></Link>
      </div>

      <div className="mb-3 flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className={cn("rounded-md px-3 py-1.5 text-sm", tab === t.key ? "bg-foreground text-background" : "bg-card hover:bg-accent")}>
            {t.label}
          </button>
        ))}
      </div>

      {rows === undefined || rows === null ? <Loading /> : rows.length === 0 ? (
        <Empty title="No purchases here">Create a purchase when you order from a supplier or factory. Upload their list or add products one by one.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Purchase</th><th className="p-3 font-medium">Supplier</th><th className="p-3 font-medium">Warehouse</th>
                <th className="p-3 font-medium">Status</th><th className="p-3 font-medium">Received</th><th className="p-3 text-right font-medium">Total</th>
                <th className="p-3 text-right font-medium">Due</th><th className="p-3 font-medium">Expected</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((p) => {
                const pct = p.orderedUnits ? Math.round(((p.receivedUnits + p.damagedUnits) / p.orderedUnits) * 100) : 0
                return (
                  <tr key={p._id} className="cursor-pointer hover:bg-muted/30" onClick={() => navigate({ to: "/purchase", search: { id: p._id } })}>
                    <td className="p-3">
                      <div className="font-semibold text-tone-blue">{poCode(p.code)}</div>
                      <div className="text-xs text-muted-foreground">{dateOnly(p.createdAt)}{p.supplierRef ? ` · Inv ${p.supplierRef}` : ""}</div>
                    </td>
                    <td className="p-3">{p.supplierName}</td>
                    <td className="p-3">{p.locationName}</td>
                    <td className="p-3"><POStatus status={p.status} label={PO_STATUS_LABEL[p.status] ?? p.status} />{p.tracking && <div className="mt-1 text-xs text-muted-foreground">{p.tracking}</div>}</td>
                    <td className="p-3 text-xs">
                      <div>{p.receivedUnits}/{p.orderedUnits} pcs{p.damagedUnits ? ` · ${p.damagedUnits} damaged` : ""}</div>
                      <div className="mt-1 h-1.5 w-28 rounded-full bg-muted"><div className="h-1.5 rounded-full bg-tone-green" style={{ width: `${pct}%` }} /></div>
                    </td>
                    <td className="p-3 text-right tabular-nums">{taka(p.total)}</td>
                    <td className={cn("p-3 text-right tabular-nums", p.due > 0 && p.status !== "draft" && p.status !== "cancelled" && "font-semibold text-tone-red")}>{taka(p.due)}</td>
                    <td className="p-3 text-xs">{p.expectedAt ? dateOnly(p.expectedAt) : "—"}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
