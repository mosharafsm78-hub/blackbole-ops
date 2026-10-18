import { useEffect, useRef, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Authenticated, AuthLoading, Unauthenticated, useQuery } from "convex/react"
import JsBarcode from "jsbarcode"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { taka } from "@/lib/format"

export const Route = createFileRoute("/labels")({
  validateSearch: (s: Record<string, unknown>) => ({ receipt: s.receipt ? String(s.receipt) : undefined, po: s.po ? String(s.po) : undefined }),
  component: () => (
    <>
      <AuthLoading><p className="p-8 text-sm">Loading…</p></AuthLoading>
      <Unauthenticated><p className="p-8 text-sm">Please sign in to BlackBole Ops first.</p></Unauthenticated>
      <Authenticated><Labels /></Authenticated>
    </>
  ),
})

function Labels() {
  const { receipt, po } = Route.useSearch()
  const rows = useQuery(api.purchasing.labelData, { receiptId: receipt as Id<"receipts"> | undefined, poId: po as Id<"purchaseOrders"> | undefined })
  const [copies, setCopies] = useState<Record<string, number>>({})
  const [showPrice, setShowPrice] = useState(true)
  if (!rows) return <p className="p-8 text-sm">Loading…</p>
  const list = rows.flatMap((r) => Array.from({ length: copies[r.sku] ?? r.qty }, () => r))
  return (
    <div className="bg-white text-black">
      <div className="no-print space-y-3 border-b p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium">{list.length} labels (38 × 25 mm)</span>
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} /> Show price</label>
          <Button size="sm" onClick={() => window.print()}>Print</Button>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {rows.map((r) => (
            <label key={r.sku} className="flex items-center gap-1 rounded border px-2 py-1">{r.sku}
              <Input type="number" className="h-6 w-14 text-xs" value={copies[r.sku] ?? r.qty} onChange={(e) => setCopies({ ...copies, [r.sku]: Math.max(0, Number(e.target.value) || 0) })} />
            </label>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-[2mm] p-[2mm]">
        {list.map((r, i) => (
          <div key={i} className="flex h-[25mm] w-[38mm] flex-col items-center justify-center overflow-hidden border border-dashed border-gray-300 px-[1mm] text-center print:border-0" style={{ breakInside: "avoid" }}>
            <div className="w-full truncate text-[7pt] font-semibold leading-tight">{r.name.replace(/^BlackBole\s+/i, "")}</div>
            <div className="text-[7pt] leading-tight">Size {r.title}{showPrice ? ` · ${taka(r.price)}` : ""}</div>
            <Code value={r.sku} />
            <div className="font-mono text-[6.5pt] leading-none">{r.sku}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Code({ value }: { value: string }) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => { if (ref.current) JsBarcode(ref.current, value, { format: "CODE128", height: 28, width: 1, margin: 0, displayValue: false }) }, [value])
  return <svg ref={ref} className="my-[0.5mm] max-w-full" />
}
