import { useEffect, useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useAction, useQuery } from "convex/react"
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Guard } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill, StatusPill } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { dateOnly, dateTime, errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/courier-payments")({
  component: () => (
    <Guard perm="orders.view">
      <CourierPayments />
    </Guard>
  ),
})

const pretty = (k: string) => k.replace(/^total_/, "total ").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())

function CourierPayments() {
  const data = useQuery(api.pathao.moneyOverview, { limit: 100 })
  const sync = useAction(api.pathao.syncMoneyNow)
  const statsFn = useAction(api.pathao.moneyStats)
  const [stats, setStats] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => { statsFn({}).then((r) => setStats(r.raw ?? {})).catch(() => setStats({})) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const runSync = async (days: number) => {
    setBusy(true)
    try {
      const r = await sync({ days })
      toast.success(`Synced: ${r.parcels} parcels checked, ${r.linked} newly linked, ${r.invoices} invoices, ${r.paidMoved} orders marked Delivered · Paid`)
      statsFn({}).then((x) => setStats(x.raw ?? {})).catch(() => {})
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }

  const statTiles = Object.entries(stats ?? {}).filter(([, v]) => Number.isFinite(Number(v)) && typeof v !== "boolean").slice(0, 4)
  const TONES = ["border-t-tone-blue", "border-t-tone-amber", "border-t-tone-green", "border-t-tone-red"]

  return (
    <div className="space-y-5">
      <PageHeader title="Pathao payments" sub="What Pathao collected from customers, what it charged, and what it has paid us — synced automatically every 30 minutes.">
        <Button variant="outline" size="sm" onClick={() => runSync(60)} disabled={busy} title="Look back 60 days">Deep sync (60 days)</Button>
        <Button size="sm" onClick={() => runSync(20)} disabled={busy}><RefreshCw className={cn("size-4", busy && "animate-spin")} /> {busy ? "Syncing…" : "Sync now"}</Button>
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats === null ? <div className="col-span-full"><Loading /></div> : statTiles.length === 0 ? null : statTiles.map(([k, v], i) => (
          <div key={k} className={cn("rounded-xl border border-t-[3px] bg-card px-4 py-3", TONES[i])}>
            <div className="text-xs font-medium text-muted-foreground">{pretty(k)}</div>
            <div className="mt-0.5 text-xl font-semibold tabular-nums">{taka(Number(v))}</div>
            <div className="text-[11px] text-muted-foreground">Live from Pathao · all time</div>
          </div>
        ))}
      </div>

      {data?.sync && (
        <p className="text-xs text-muted-foreground">
          Last sync {dateTime(data.sync.at)} — {data.sync.parcels} parcels checked, {data.sync.linked} linked to orders, {data.sync.invoices} invoices read, {data.sync.paidMoved} orders moved to Delivered · Paid.
        </p>
      )}

      {data === undefined ? <Loading /> : data.invoices.length === 0 ? (
        <Empty title="No Pathao invoices synced yet">Click “Sync now”. The first sync reads the last 20 days of parcels and invoices.</Empty>
      ) : (
        <section className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-8 p-3" /><th className="p-3 font-medium">Invoice</th><th className="p-3 font-medium">Date</th>
                <th className="p-3 text-right font-medium">Parcels</th><th className="p-3 text-right font-medium">Collected</th>
                <th className="p-3 text-right font-medium">Delivery fee</th><th className="p-3 text-right font-medium">COD fee</th>
                <th className="p-3 text-right font-medium">Discount</th><th className="p-3 text-right font-medium">Pathao fee</th>
                <th className="p-3 text-right font-medium">Paid to us</th><th className="p-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.invoices.map((inv) => (
                <InvoiceRow key={inv._id} inv={inv} open={open === inv.invoiceId} onToggle={() => setOpen(open === inv.invoiceId ? null : inv.invoiceId)} />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

type Inv = NonNullable<ReturnType<typeof useQuery<typeof api.pathao.moneyOverview>>>["invoices"][number]

function InvoiceRow({ inv, open, onToggle }: { inv: Inv; open: boolean; onToggle: () => void }) {
  const orders = useQuery(api.pathao.invoiceOrders, open ? { invoiceId: inv.invoiceId } : "skip")
  const paid = inv.status.toLowerCase() === "paid"
  return (
    <>
      <tr className="cursor-pointer hover:bg-muted/30" onClick={onToggle}>
        <td className="p-3 text-muted-foreground">{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</td>
        <td className="p-3 font-mono text-xs font-semibold">{inv.invoiceId}</td>
        <td className="p-3 whitespace-nowrap">{dateOnly(inv.createdAt)}</td>
        <td className="p-3 text-right tabular-nums">{inv.matched}/{inv.parcels}</td>
        <td className="p-3 text-right tabular-nums">{taka(inv.collected)}</td>
        <td className="p-3 text-right tabular-nums">{taka(inv.deliveryFee)}</td>
        <td className="p-3 text-right tabular-nums">{taka(inv.codFee)}</td>
        <td className="p-3 text-right tabular-nums text-tone-green">−{taka(inv.discount)}</td>
        <td className="p-3 text-right tabular-nums text-tone-red">{taka(inv.totalFee)}</td>
        <td className="p-3 text-right font-semibold tabular-nums">{taka(inv.receivable)}</td>
        <td className="p-3"><Pill tone={paid ? "green" : "amber"}>{paid ? "Paid" : inv.status || "Unpaid"}</Pill></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={11} className="bg-muted/20 px-6 py-3">
            {orders === undefined ? <Loading /> : orders.length === 0 ? <p className="text-sm text-muted-foreground">None of these parcels are linked to orders in this app yet.</p> : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr><th className="py-1.5 font-medium">Order</th><th className="py-1.5 font-medium">Customer</th><th className="py-1.5 font-medium">Consignment</th><th className="py-1.5 font-medium">Status</th><th className="py-1.5 text-right font-medium">Order total</th><th className="py-1.5 text-right font-medium">Collected</th><th className="py-1.5 text-right font-medium">Fee</th><th className="py-1.5 text-right font-medium">Paid to us</th></tr>
                </thead>
                <tbody className="divide-y">
                  {orders.map((o) => (
                    <tr key={o._id}>
                      <td className="py-1.5"><Link to="/order" search={{ id: o._id }} className="font-semibold text-tone-blue hover:underline">{o.invoice}</Link></td>
                      <td className="py-1.5">{o.customer}</td>
                      <td className="py-1.5 font-mono text-xs">{o.consignmentId}</td>
                      <td className="py-1.5"><StatusPill status={o.status} /></td>
                      <td className="py-1.5 text-right tabular-nums">{taka(o.total)}</td>
                      <td className="py-1.5 text-right tabular-nums">{o.collected !== null ? taka(o.collected) : "—"}</td>
                      <td className="py-1.5 text-right tabular-nums">{o.fee !== null ? taka(o.fee) : "—"}</td>
                      <td className="py-1.5 text-right font-semibold tabular-nums">{o.payout !== null ? taka(o.payout) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
