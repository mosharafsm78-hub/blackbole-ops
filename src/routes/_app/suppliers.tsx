import { useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { Plus } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { Guard, useCan } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill } from "@/components/bits"
import { SupplierDialog } from "@/components/purchase-parts"
import { Button } from "@/components/ui/button"
import { dateOnly, taka } from "@/lib/format"

export const Route = createFileRoute("/_app/suppliers")({
  component: () => (
    <Guard perm="inventory.receive">
      <Suppliers />
    </Guard>
  ),
})

type Supplier = NonNullable<ReturnType<typeof useQuery<typeof api.purchasing.listSuppliers>>>[number]

function Suppliers() {
  const can = useCan()
  const rows = useQuery(api.purchasing.listSuppliers)
  const [edit, setEdit] = useState<Supplier | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <div>
      <PageHeader title="Suppliers" sub="Factories and suppliers you buy from — what you bought, paid and still owe.">
        <Button variant="outline" size="sm" asChild><Link to="/purchases">Purchases</Link></Button>
        {can("purchases.manage") && <Button size="sm" onClick={() => { setEdit(null); setOpen(true) }}><Plus className="size-4" /> New supplier</Button>}
      </PageHeader>
      {rows === undefined ? <Loading /> : rows.length === 0 ? (
        <Empty title="No suppliers yet">Add your factory and suppliers here, then create purchases for them.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Supplier</th><th className="p-3 font-medium">Contact</th><th className="p-3 text-right font-medium">Purchases</th>
                <th className="p-3 text-right font-medium">Bought</th><th className="p-3 text-right font-medium">Paid</th><th className="p-3 text-right font-medium">Due</th>
                <th className="p-3 font-medium">Last purchase</th><th className="p-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((s) => (
                <tr key={s._id} className="hover:bg-muted/30">
                  <td className="p-3"><div className="font-medium">{s.name} {!s.active && <Pill tone="gray">Inactive</Pill>}</div>{s.address && <div className="text-xs text-muted-foreground">{s.address}</div>}</td>
                  <td className="p-3 text-xs">{[s.contactPerson, s.phone, s.email].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="p-3 text-right tabular-nums">{s.poCount}</td>
                  <td className="p-3 text-right tabular-nums">{taka(s.purchased)}</td>
                  <td className="p-3 text-right tabular-nums">{taka(s.paid)}</td>
                  <td className={`p-3 text-right tabular-nums ${s.due > 0 ? "font-semibold text-tone-red" : ""}`}>{taka(s.due)}</td>
                  <td className="p-3 text-xs">{s.lastAt ? dateOnly(s.lastAt) : "—"}</td>
                  <td className="p-3 text-right">{can("purchases.manage") && <Button size="sm" variant="ghost" onClick={() => { setEdit(s); setOpen(true) }}>Edit</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <SupplierDialog supplier={edit} open={open} onOpenChange={setOpen} />
    </div>
  )
}
