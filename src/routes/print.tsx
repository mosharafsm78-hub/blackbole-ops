import { useEffect, useRef, useState } from "react"
import JsBarcode from "jsbarcode"
import { createFileRoute } from "@tanstack/react-router"
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Button } from "@/components/ui/button"
import { invoice } from "@/lib/format"

export const Route = createFileRoute("/print")({
  validateSearch: (s: Record<string, unknown>) => ({ ids: String(s.ids ?? ""), preview: s.preview ? 1 : undefined }),
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

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const longDate = (t: number) => new Date(t).toLocaleDateString("en-US", { timeZone: "Asia/Dhaka", month: "long", day: "numeric", year: "numeric" })

type Layout = "smart" | "half" | "full"
const LAYOUTS: { k: Layout; label: string }[] = [
  { k: "smart", label: "Smart (as many as fit)" },
  { k: "half", label: "2 per page" },
  { k: "full", label: "1 per page" },
]
function readLayout(): Layout {
  try { const v = localStorage.getItem("invoiceLayout"); return v === "half" || v === "full" ? v : "smart" } catch { return "smart" }
}

function Invoices() {
  const { ids, preview } = Route.useSearch()
  const list = ids.split(",").filter(Boolean) as Id<"orders">[]
  const orders = useQuery(api.orders.printData, { ids: list })
  const mark = useMutation(api.orders.markPrinted)
  const done = useRef(false)
  const [layout, setLayout] = useState<Layout>(readLayout)

  useEffect(() => {
    if (orders && orders.length && !done.current && !preview) {
      done.current = true
      mark({ ids: orders.map((o) => o._id) }).catch(() => {})
      setTimeout(() => window.print(), 500)
    }
  }, [orders, mark, preview])

  if (!orders) return <p className="p-8 text-sm">Loading…</p>
  const choose = (l: Layout) => { setLayout(l); try { localStorage.setItem("invoiceLayout", l) } catch { /* optional */ } }

  return (
    <div className="min-h-screen bg-neutral-200 text-black print:bg-white">
      {/* margin 0 = the browser prints no web address / date / page number on the paper */}
      <style>{`
        @page { size: A4; margin: 0; }
        @media print { .no-print { display: none !important; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .sheet { margin: 0 !important; box-shadow: none !important; } }
        .inv { break-inside: avoid; page-break-inside: avoid; }
      `}</style>
      <div className="no-print sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b bg-white p-3">
        <span className="text-sm font-medium">{orders.length} invoice{orders.length > 1 ? "s" : ""}</span>
        <div className="flex overflow-hidden rounded-md border text-sm">
          {LAYOUTS.map((l) => (
            <button key={l.k} type="button" onClick={() => choose(l.k)} className={`px-3 py-1.5 ${layout === l.k ? "bg-black text-white" : ""}`}>{l.label}</button>
          ))}
        </div>
        <Button size="sm" onClick={() => window.print()}>Print</Button>
        <span className="text-xs text-muted-foreground">Cut along the dashed lines.</span>
      </div>
      {layout === "smart" ? (
        // each invoice only as tall as it needs; they flow down the A4 sheet and never split across pages
        <div className="sheet mx-auto my-4 w-[210mm] bg-white px-[8mm] py-[6mm] shadow" data-testid="invoice-sheet">
          {orders.map((o, k) => (
            <div key={o._id} className="inv" style={{ borderTop: k > 0 ? "1px dashed #888" : undefined }}>
              <Invoice o={o} />
            </div>
          ))}
        </div>
      ) : (
        chunk(orders, layout === "half" ? 2 : 1).map((sheet, si) => (
          <div key={si} className="sheet mx-auto my-4 flex w-[210mm] flex-col bg-white px-[8mm] shadow" style={{ height: "297mm", breakAfter: "page", overflow: "hidden" }} data-testid="invoice-sheet">
            {sheet.map((o, k) => (
              <div key={o._id} className="inv overflow-hidden" style={{ height: layout === "half" ? "148.5mm" : "297mm", borderTop: k > 0 ? "1px dashed #888" : undefined }}>
                <Invoice o={o} />
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  )
}

function chunk<T>(arr: T[], n: number) {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

type PrintOrder = NonNullable<ReturnType<typeof useQuery<typeof api.orders.printData>>>[number]

/** Compact invoice like Nuport: customer (Bill To) and invoice info share the top block, then items and totals. */
function Invoice({ o }: { o: PrintOrder }) {
  const no = o.invoiceCode ?? invoice(o.invoiceNo)
  const discount = o.items.reduce((s, i) => s + i.discount, 0) + o.discount
  const sub = o.items.reduce((s, i) => s + i.price * i.qty, 0)
  const place = [o.areaName, o.zoneName, o.cityName].filter(Boolean).join(", ")
  return (
    <div className="py-[5mm] text-[10px] leading-snug" data-testid="invoice">
      {/* top block: brand + Bill To on the left, barcode + invoice info on the right */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[14px] font-black tracking-[0.18em]">BLACKBOLE</span>
            <span className="text-[8px] text-neutral-600">Passionate with Fashion · blackbole.com</span>
          </div>
          <div className="mt-1.5 text-[9px] font-bold uppercase text-neutral-600">Bill To</div>
          <div className="text-[11.5px] font-bold">{o.customerName}</div>
          <div className="text-[11px] font-semibold">{o.phone}</div>
          <div className="max-w-[105mm]">{o.address}{place ? `, ${place}` : ""}</div>
        </div>
        <div className="shrink-0 text-right">
          <Barcode value={no} height={30} />
          <div className="text-[12px] font-bold">{no}</div>
          <div>Delivery: <b>{o.courier === "pickup" ? "Store pickup" : o.deliveryPartnerName ?? "Pathao"}</b>{o.consignmentId ? <> · <b>{o.consignmentId}</b></> : null}</div>
          <div>Date: <b>{longDate(o.createdAt)}</b>{o.externalName ? <> · Web {o.externalName}</> : null}</div>
          <div className="mt-1 inline-block rounded bg-black px-2 py-0.5 text-[12px] font-bold text-white">Collect: ৳{money(o.due)}</div>
        </div>
      </div>

      {/* items */}
      <table className="mt-2 w-full border-collapse">
        <thead>
          <tr className="bg-neutral-200 text-left">
            <th className="border border-neutral-300 px-1 py-0.5 font-semibold">SL</th>
            <th className="border border-neutral-300 px-1 py-0.5 font-semibold">SKU</th>
            <th className="border border-neutral-300 px-1 py-0.5 font-semibold">Item</th>
            <th className="border border-neutral-300 px-1 py-0.5 font-semibold">Weight</th>
            <th className="border border-neutral-300 px-1 py-0.5 text-right font-semibold">Unit price</th>
            <th className="border border-neutral-300 px-1 py-0.5 text-right font-semibold">Qty</th>
            <th className="border border-neutral-300 px-1 py-0.5 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {o.items.map((i, k) => (
            <tr key={k} className="align-top">
              <td className="border border-neutral-300 px-1 py-0.5">{k + 1}</td>
              <td className="border border-neutral-300 px-1 py-0.5 whitespace-nowrap">{i.sku}</td>
              <td className="border border-neutral-300 px-1 py-0.5 font-medium">{i.name}{i.attrs ? ` - ${i.attrs}` : ""}</td>
              <td className="border border-neutral-300 px-1 py-0.5 whitespace-nowrap">{i.weightKg ? `${i.weightKg} kg` : ""}</td>
              <td className="border border-neutral-300 px-1 py-0.5 text-right">{money(i.price)}</td>
              <td className="border border-neutral-300 px-1 py-0.5 text-right">{i.qty}</td>
              <td className="border border-neutral-300 px-1 py-0.5 text-right">{money(i.price * i.qty)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* totals on one line block */}
      <div className="mt-1.5 flex items-start justify-between gap-4">
        <div className="max-w-[100mm] text-[8.5px] text-neutral-700">
          {o.customerNote && <div className="mb-1 rounded border border-neutral-400 p-1 text-[9.5px] text-black"><b>Note:</b> {o.customerNote}</div>}
          {o.isExchange && <div className="mb-1 text-[10px] font-bold text-black">EXCHANGE — collect the old item</div>}
          Thank you for shopping with BlackBole. For exchange or help, contact us on Facebook or blackbole.com.
        </div>
        <table className="shrink-0 border-collapse text-[9.5px]">
          <tbody>
            <tr>
              <Cell k="Sub total" v={money(sub)} />
              <Cell k="Discount" v={`- ${money(discount)}`} />
              <Cell k="Delivery" v={money(o.deliveryFee)} />
              <Cell k="Grand total" v={money(o.total)} cls="bg-neutral-200 font-bold" />
              <Cell k="Paid" v={money(o.paidAmount)} />
              <Cell k="Due" v={money(o.due)} cls="bg-black font-bold text-white" />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Cell({ k, v, cls = "" }: { k: string; v: string; cls?: string }) {
  return (
    <td className={`border border-neutral-300 px-1.5 py-0.5 text-right ${cls}`}>
      <div className="text-[8px] font-normal opacity-80">{k}</div>
      <div className="tabular-nums">{v}</div>
    </td>
  )
}

/** Code 128 barcode of the invoice number, scanned on the Scan page. */
function Barcode({ value, height }: { value: string; height: number }) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (ref.current) JsBarcode(ref.current, value, { format: "CODE128", height, width: 1.6, margin: 0, displayValue: false })
  }, [value, height])
  return <svg ref={ref} className="mb-1 ml-auto" data-testid="invoice-barcode" />
}
