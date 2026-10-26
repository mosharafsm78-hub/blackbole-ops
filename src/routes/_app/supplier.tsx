import { useEffect, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ArrowLeft, Pencil, Printer, Wallet } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { PO_STATUS_LABEL, SUPPLIER_PAY_METHODS } from "@/convex/rules"
import { Guard, useCan, Perm } from "@/components/app-shell"
import { Loading, PageHeader, Stat } from "@/components/bits"
import { POStatus, SlipLink, SupplierDialog, SupplierPayDialog, poCode } from "@/components/purchase-parts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dateOnly, errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/supplier")({
  validateSearch: (s: Record<string, unknown>) => ({ id: String(s.id ?? "") }),
  component: () => (
    <Guard perm="inventory.receive">
      <SupplierPage />
    </Guard>
  ),
})

function SupplierPage() {
  const { id } = Route.useSearch()
  const can = useCan()
  const navigate = useNavigate()
  const st = useQuery(api.purchasing.supplierStatement, { id: id as Id<"suppliers"> })
  const [pay, setPay] = useState(false)
  const [edit, setEdit] = useState(false)
  if (st === undefined) return <Loading />
  if (st === null) return <p className="text-sm text-muted-foreground">Supplier not found.</p>
  const sp = st.supplier
  return (
    <div className="space-y-4">
      <div className="no-print text-sm"><Link to="/suppliers" className="inline-flex items-center gap-1 text-muted-foreground hover:underline"><ArrowLeft className="size-4" /> Suppliers</Link></div>
      <PageHeader title={sp.name} sub={[sp.contactPerson, sp.phone, sp.email, sp.address].filter(Boolean).join(" · ") || "Supplier account"}>
        <div className="no-print flex flex-wrap gap-2">
          {<Perm perm="purchases.manage"><Button size="sm" variant="outline" onClick={() => setEdit(true)}><Pencil className="size-4" /> Edit</Button></Perm>}
          <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="size-4" /> Print statement</Button>
          {<Perm perm="purchases.pay"><Button size="sm" onClick={() => setPay(true)}><Wallet className="size-4" /> Pay supplier</Button></Perm>}
        </div>
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Total bought" value={taka(st.purchased)} hint={st.opening ? `+ previous due ${taka(st.opening)}` : undefined} />
        <Stat label="Total paid" value={taka(st.paid)} tone="green" />
        {st.due >= 0
          ? <Stat label="We owe now" value={taka(st.due)} tone={st.due > 0 ? "red" : undefined} />
          : <Stat label="Paid in advance" value={taka(-st.due)} tone="blue" hint="Will be used for the next purchase" />}
        <Stat label="Unpaid purchases" value={st.openPOs.length} />
      </div>

      {st.openPOs.length > 0 && (
        <section className="no-print rounded-lg border bg-card">
          <h2 className="border-b p-3 text-sm font-semibold">Unpaid purchases (oldest first — payments clear these in this order)</h2>
          <table className="w-full text-sm">
            <tbody className="divide-y">
              {st.openPOs.map((p) => (
                <tr key={p._id} className="cursor-pointer hover:bg-muted/30" onClick={() => navigate({ to: "/purchase", search: { id: p._id } })}>
                  <td className="p-3 font-semibold text-tone-blue">{poCode(p.code)}</td>
                  <td className="p-3 text-xs">{dateOnly(p.createdAt)}</td>
                  <td className="p-3"><POStatus status={p.status} label={PO_STATUS_LABEL[p.status] ?? p.status} /></td>
                  <td className="p-3 text-right tabular-nums">{taka(p.total)}</td>
                  <td className="p-3 text-right tabular-nums text-tone-green">{taka(p.paid)}</td>
                  <td className="p-3 text-right font-semibold tabular-nums text-tone-red">{taka(p.due)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="rounded-lg border bg-card">
        <h2 className="border-b p-3 text-sm font-semibold">Statement</h2>
        {st.rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No purchases or payments yet.</p> : (
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-3 font-medium">Date</th><th className="p-3 font-medium">Details</th><th className="p-3 text-right font-medium">Purchase</th><th className="p-3 text-right font-medium">Payment</th><th className="p-3 text-right font-medium">Balance (we owe)</th></tr>
            </thead>
            <tbody className="divide-y">
              {st.rows.map((r, i) => (
                <tr key={i} className={cn(r.poId && "cursor-pointer hover:bg-muted/30")} onClick={() => r.poId && navigate({ to: "/purchase", search: { id: r.poId } })}>
                  <td className="p-3 text-xs whitespace-nowrap">{dateOnly(r.at)}</td>
                  <td className="p-3">{r.text}{r.paymentId && <span className="no-print ml-2"><SlipLink paymentId={r.paymentId} url={r.slipUrl} /></span>}</td>
                  <td className="p-3 text-right tabular-nums">{r.debit ? taka(r.debit) : ""}</td>
                  <td className="p-3 text-right tabular-nums text-tone-green">{r.credit ? taka(r.credit) : ""}</td>
                  <td className={cn("p-3 text-right font-medium tabular-nums", r.balance > 0 ? "text-tone-red" : r.balance < 0 ? "text-tone-blue" : "")}>{r.balance < 0 ? `${taka(-r.balance)} advance` : taka(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <SupplierPayDialog supplierId={sp._id} open={pay} onOpenChange={setPay} />
      <SupplierDialog supplier={sp} open={edit} onOpenChange={setEdit} />
    </div>
  )
}

