import { useEffect, useRef } from "react"
import JsBarcode from "jsbarcode"
import { createFileRoute } from "@tanstack/react-router"
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Button } from "@/components/ui/button"
import { dateOnly, invoice, taka } from "@/lib/format"

export const Route = createFileRoute("/print")({
  validateSearch: (s: Record<string, unknown>) => ({ ids: String(s.ids ?? "") }),
  component: PrintRoute,
})

function PrintRoute() {
  return (
    <>
      <AuthLoading><p className="p-8 text-sm">Loading…</p></AuthLoading>
      <Unauthenticated><p className="p-8 text-sm">Please sign in to BlackBole Ops first.</p></Unauthenticated>
      <Authenticated><Invoices /></Authenticated>
    </>
  )
}

function Invoices() {
  const { ids } = Route.useSearch()
  const list = ids.split(",").filter(Boolean) as Id<"orders">[]
  const orders = useQuery(api.orders.printData, { ids: list })
  const mark = useMutation(api.orders.markPrinted)
  const done = useRef(false)

  useEffect(() => {
    if (orders && orders.length && !done.current) {
      done.current = true
      mark({ ids: orders.map((o) => o._id) }).catch(() => {})
      setTimeout(() => window.print(), 400)
    }
  }, [orders, mark])

  if (!orders) return <p className="p-8 text-sm">Loading…</p>
  return (
    <div className="bg-white text-black">
      <div className="no-print flex items-center gap-3 border-b p-3">
        <span className="text-sm">{orders.length} invoice{orders.length > 1 ? "s" : ""}</span>
        <Button size="sm" onClick={() => window.print()}>Print</Button>
      </div>
      {orders.map((o) => (
        <div key={o._id} className="mx-auto max-w-[760px] p-8 text-[13px]" style={{ breakAfter: "page" }}>
          <div className="flex items-start justify-between border-b-2 border-black pb-3">
            <div>
              <div className="text-2xl font-bold tracking-wide">BLACKBOLE</div>
              <div className="text-xs">Passionate with Fashion · blackbole.com</div>
              <div className="text-xs">{o.locationName}</div>
            </div>
            <div className="text-right">
              <div className="text-lg font-bold">{o.invoiceCode ?? invoice(o.invoiceNo)}</div>
              <Barcode value={o.invoiceCode ?? invoice(o.invoiceNo)} />
              <div className="text-xs">Date: {dateOnly(o.createdAt)}</div>
              {o.externalName && <div className="text-xs">Web order {o.externalName}</div>}
              {o.consignmentId && <div className="text-xs font-semibold">Pathao: {o.consignmentId}</div>}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-semibold uppercase">Deliver to</div>
              <div className="font-semibold">{o.customerName}</div>
              <div>{o.phone}</div>
              <div>{o.address}</div>
              <div>{[o.areaName, o.zoneName, o.cityName].filter(Boolean).join(", ")}</div>
            </div>
            <div className="text-right">
              <div className="text-xs font-semibold uppercase">Collect on delivery</div>
              <div className="text-3xl font-bold">{taka(o.due)}</div>
              {o.paidAmount > 0 && <div className="text-xs">Paid in advance {taka(o.paidAmount)}</div>}
            </div>
          </div>
          <table className="mt-4 w-full border-collapse">
            <thead>
              <tr className="border-y border-black text-left">
                <th className="py-1.5">Item</th><th className="py-1.5">SKU</th><th className="py-1.5 text-right">Qty</th><th className="py-1.5 text-right">Price</th><th className="py-1.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {o.items.map((i, k) => (
                <tr key={k} className="border-b border-dotted">
                  <td className="py-1.5">{i.name}{i.attrs ? ` (${i.attrs})` : ""}</td>
                  <td className="py-1.5">{i.sku}</td>
                  <td className="py-1.5 text-right">{i.qty}</td>
                  <td className="py-1.5 text-right">{taka(i.price)}</td>
                  <td className="py-1.5 text-right">{taka(i.price * i.qty - i.discount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ml-auto mt-3 w-64 space-y-0.5">
            <div className="flex justify-between"><span>Subtotal</span><span>{taka(o.subtotal)}</span></div>
            <div className="flex justify-between"><span>Discount</span><span>−{taka(o.items.reduce((s, i) => s + i.discount, 0) + o.discount)}</span></div>
            <div className="flex justify-between"><span>Delivery</span><span>{taka(o.deliveryFee)}</span></div>
            <div className="flex justify-between font-bold"><span>Total</span><span>{taka(o.total)}</span></div>
            <div className="flex justify-between"><span>Paid</span><span>−{taka(o.paidAmount)}</span></div>
            <div className="flex justify-between border-t border-black pt-1 text-base font-bold"><span>Due</span><span>{taka(o.due)}</span></div>
          </div>
          {o.customerNote && <div className="mt-3 border p-2 text-xs">Note: {o.customerNote}</div>}
          <div className="mt-6 text-center text-xs">Thank you for shopping with BlackBole. For exchange or help, contact us on Facebook or blackbole.com.</div>
        </div>
      ))}
    </div>
  )
}

/** Code 128 barcode of the invoice number, scanned on the Scan page. */
function Barcode({ value }: { value: string }) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (ref.current) JsBarcode(ref.current, value, { format: "CODE128", height: 40, width: 1.6, fontSize: 11, margin: 0, displayValue: false })
  }, [value])
  return <svg ref={ref} className="ml-auto mt-1" data-testid="invoice-barcode" />
}
