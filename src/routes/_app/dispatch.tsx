import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { Copy, Download, MessageCircle } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Guard } from "@/components/app-shell"
import { Loading, PageHeader } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { startOfDayBD } from "@/lib/format"

export const Route = createFileRoute("/_app/dispatch")({
  component: () => (
    <Guard perm="orders.view">
      <Dispatch />
    </Guard>
  ),
})

const BD = 6 * 3600000
const dayKey = (t: number) => new Date(t + BD).toISOString().slice(0, 10)
const dayStart = (k: string) => Date.parse(`${k}T00:00:00Z`) - BD
const nice = (k: string) => new Date(dayStart(k) + BD).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })
const n = (x: number) => Math.round(x).toLocaleString("en-IN")

const LINES = [
  ["Total Order Quantity", "orders"],
  ["Total Product Quantity", "qty"],
  ["Total Product Value", "productValue"],
  ["Total Shipping Charge", "shipping"],
  ["Total Order Value", "orderValue"],
  ["Total Discount", "discount"],
  ["Total Advance Payment", "advance"],
  ["Total Due Amount", "due"],
] as const

function Dispatch() {
  const today = dayKey(Date.now())
  const [day, setDay] = useState(today)
  const [loc, setLoc] = useState("__all")
  const [partner, setPartner] = useState("__all")
  const data = useQuery(api.dispatch.summary, {
    from: dayStart(day), to: dayStart(day) + 86400000 - 1,
    locationId: loc === "__all" ? undefined : (loc as Id<"locations">),
    partner: partner === "__all" ? undefined : partner,
  })
  const row = data?.total ?? null
  const whName = loc === "__all" ? "All warehouses" : data?.allWarehouses.find((w) => w.id === loc)?.name ?? "Warehouse"
  const title = partner === "__all" ? "All couriers" : partner
  const dates = nice(day)

  const text = row
    ? [`📦 *BlackBole Dispatch Update*`, `Warehouse: ${whName}`, `Delivery Partner: ${title}`, `In-Transit Date: ${dates}`, "", ...LINES.map(([label, k]) => `${label}: ${n((row as any)[k])}`)].join("\n")
    : ""

  const copy = async () => { try { await navigator.clipboard.writeText(text); toast.success("Copied — paste it in the WhatsApp group") } catch { toast.error("Couldn't copy") } }
  const share = () => window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank")
  const image = () => {
    if (!row) return
    const W = 720, rowH = 46, top = 140, H = top + rowH * (LINES.length + 1) + 30
    const c = document.createElement("canvas"); c.width = W * 2; c.height = H * 2
    const g = c.getContext("2d")!; g.scale(2, 2)
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H)
    g.fillStyle = "#111"; g.textAlign = "center"; g.font = "bold 18px Arial"
    g.fillText(`Warehouse: ${whName}`, W / 2, 44); g.fillText(`Delivery Partner: ${title}`, W / 2, 72); g.fillText(`In-Transit Date: ${dates}`, W / 2, 100)
    g.fillStyle = "#f4f4f5"; g.fillRect(24, top, W - 48, rowH)
    g.fillStyle = "#111"; g.font = "bold 16px Arial"; g.textAlign = "left"; g.fillText("Description", 40, top + 29)
    g.textAlign = "right"; g.fillText("Amount", W - 40, top + 29)
    g.font = "15px Arial"
    LINES.forEach(([label, k], i) => {
      const y = top + rowH * (i + 1)
      g.strokeStyle = "#e4e4e7"; g.beginPath(); g.moveTo(24, y + rowH); g.lineTo(W - 24, y + rowH); g.stroke()
      g.fillStyle = "#333"; g.textAlign = "left"; g.fillText(label, 40, y + 29)
      g.textAlign = "right"; g.fillText(n((row as any)[k]), W - 40, y + 29)
    })
    const a = document.createElement("a"); a.href = c.toDataURL("image/png"); a.download = `dispatch-${day}-${whName.replace(/\W+/g, "-")}-${title.replace(/\W+/g, "-")}.png`; a.click()
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Dispatch report" sub="Parcels handed to couriers, by the day they moved to In Transit. Share it in the WhatsApp group as the daily sales update." />
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
        <div className="space-y-1.5"><Label>Date</Label><Input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} /></div>
        <div className="space-y-1.5">
          <Label>Warehouse</Label>
          <Select value={loc} onValueChange={setLoc}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All warehouses</SelectItem>
              {(data?.allWarehouses ?? []).map((w) => {
                const c = data?.warehouses.find((x) => x.id === w.id)?.orders ?? 0
                return <SelectItem key={w.id} value={w.id}>{w.name} ({c})</SelectItem>
              })}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Delivery partner</Label>
          <Select value={partner} onValueChange={setPartner}>
            <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All couriers</SelectItem>
              {(data?.partners ?? []).map((p) => <SelectItem key={p.name} value={p.name}>{p.name} ({p.orders})</SelectItem>)}
              {partner !== "__all" && !(data?.partners ?? []).some((p) => p.name === partner) && <SelectItem value={partner}>{partner} (0)</SelectItem>}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={() => setDay(dayKey(Date.now() - 86400000))}>Yesterday</Button>
        <Button variant="outline" size="sm" onClick={() => setDay(today)}>Today</Button>
      </div>

      {data === undefined ? <Loading /> : (
        <div className="rounded-xl border bg-card p-6" data-testid="dispatch-card">
          <div className="mb-5 text-center">
            <div className="font-semibold">Warehouse: {whName}</div>
            <div className="font-semibold">Delivery Partner: {title}</div>
            <div className="font-semibold">In-Transit Date: {dates}</div>
          </div>
          {!row || row.orders === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No parcels went out on this date for this choice.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="bg-muted"><th className="p-3 text-left font-semibold">Description</th><th className="p-3 text-right font-semibold">Amount</th></tr></thead>
              <tbody>
                {LINES.map(([label, k]) => (
                  <tr key={k} className="border-b"><td className="p-3">{label}</td><td className="p-3 text-right tabular-nums">{n((row as any)[k])}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {row && row.orders > 0 && (
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={share}><MessageCircle className="size-4" /> Share on WhatsApp</Button>
              <Button size="sm" variant="outline" onClick={copy}><Copy className="size-4" /> Copy text</Button>
              <Button size="sm" variant="outline" onClick={image}><Download className="size-4" /> Save as image</Button>
            </div>
          )}
          {loc === "__all" && data.warehouses.length > 1 && (
            <div className="mt-5 text-xs text-muted-foreground">By warehouse: {data.warehouses.map((w) => `${w.name} ${w.orders}`).join(" · ")}</div>
          )}
        </div>
      )}
    </div>
  )
}
