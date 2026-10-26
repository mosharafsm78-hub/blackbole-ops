import { useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { Plus } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { Guard, useCan, Perm } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill, Stat } from "@/components/bits"
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
  const navigate = useNavigate()
  const rows = useQuery(api.purchasing.listSuppliers)
  const [edit, setEdit] = useState<Supplier | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <div>
      <PageHeader title="Suppliers" sub="Factories and suppliers you buy from — what you bought, paid and still owe.">
        <Button variant="outline" size="sm" asChild><Link to="/purchases">Purchases</Link></Button>
        {<Perm perm="purchases.manage"><Button size="sm" onClick={() => { setEdit(null); setOpen(true) }}><Plus className="size-4" /> New supplier</Button></Perm>}
      </PageHeader>
      {rows && rows.length > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Stat label="Total bought" value={taka(rows.reduce((t, s) => t + s.purchased, 0))} />
          <Stat label="Total paid" value={taka(rows.reduce((t, s) => t + s.paid, 0))} tone="green" />
          <Stat label="We owe all suppliers" value={taka(rows.reduce((t, s) => t + Math.max(0, s.due), 0))} tone="red" />
        </div>
      )}
      {rows === undefined ? <Loading /> : rows.length === 0 ? (
        <Empty title="No suppliers yet">Add your factory and suppliers here, then create purchases for them.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Factory</th><th className="p-3 font-medium">Representative</th><th className="p-3 text-right font-medium">Purchases</th>
                <th className="p-3 text-right font-medium">Bought</th><th className="p-3 text-right font-medium">Paid</th><th className="p-3 text-right font-medium">Due</th>
                <th className="p-3 font-medium">Last purchase</th><th className="p-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((s) => (
                <tr key={s._id} className="cursor-pointer hover:bg-muted/30" onClick={() => navigate({ to: "/supplier", search: { id: s._id } })}>
                  <td className="p-3"><div className="font-medium">{s.name} {!s.active && <Pill tone="gray">Inactive</Pill>}</div>{s.address && <div className="text-xs text-muted-foreground">{s.address}</div>}</td>
                  <td className="p-3 text-xs">{[s.contactPerson, s.phone, s.email].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="p-3 text-right tabular-nums">{s.poCount}</td>
                  <td className="p-3 text-right tabular-nums">{taka(s.purchased)}</td>
                  <td className="p-3 text-right tabular-nums">{taka(s.paid)}</td>
                  <td className={`p-3 text-right tabular-nums ${s.due > 0 ? "font-semibold text-tone-red" : s.due < 0 ? "text-tone-blue" : ""}`}>{s.due < 0 ? `${taka(-s.due)} adv.` : taka(s.due)}</td>
                  <td className="p-3 text-xs">{s.lastAt ? dateOnly(s.lastAt) : "—"}</td>
                  <td className="p-3 text-right">{<Perm perm="purchases.manage"><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setEdit(s); setOpen(true) }}>Edit</Button></Perm>}</td>
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
