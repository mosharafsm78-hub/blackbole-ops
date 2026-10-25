import { useEffect, useRef, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { OrderStatus } from "@/convex/rules"
import { Guard } from "@/components/app-shell"
import { PageHeader } from "@/components/bits"
import { Input } from "@/components/ui/input"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/scan")({
  component: () => (
    <Guard perm="orders.view">
      <ScanPage />
    </Guard>
  ),
})

const MODES: { to: OrderStatus; label: string; hint: string }[] = [
  { to: "ready_to_ship", label: "Packed → Ready To Ship", hint: "Scan the invoice on the box. Packed and waiting for the rider (sent to Pathao only if Settings says “at Ready To Ship”)." },
  { to: "processing", label: "Start → Processing", hint: "Scan to start packing an approved (or arrived pre-order) order." },
  { to: "in_transit", label: "Handed over → In Transit", hint: "Scan each parcel you hand to the rider. Pathao orders are sent to Pathao now if not sent yet." },
  { to: "returned", label: "Return received → Returned", hint: "Scan a returned parcel in good condition. Stock goes back to Available and can be sold again." },
  { to: "damaged", label: "Return damaged → Damaged", hint: "Scan a returned parcel that came back damaged. Stock goes to Damaged, not Available." },
]

type Line = { at: number; code: string; ok: boolean; text: string }

function beep(ok: boolean) {
  try {
    const ctx = new AudioContext()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.value = ok ? 880 : 220
    g.gain.value = 0.15
    o.connect(g).connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + (ok ? 0.12 : 0.35))
  } catch { /* sound is optional */ }
}

function ScanPage() {
  const fast = useMutation(api.orders.fastAction)
  const [mode, setMode] = useState(0)
  const [code, setCode] = useState("")
  const [lines, setLines] = useState<Line[]>([])
  const input = useRef<HTMLInputElement>(null)
  const m = MODES[mode]

  useEffect(() => { input.current?.focus() }, [mode])
  // Keep the cursor in the box so a handheld scanner always types into it.
  useEffect(() => {
    const t = setInterval(() => { if (document.activeElement?.tagName !== "INPUT" && !document.querySelector("[role=dialog]")) input.current?.focus() }, 1000)
    return () => clearInterval(t)
  }, [])

  async function submit(raw: string) {
    const c = raw.trim()
    if (!c) return
    setCode("")
    try {
      const r = await fast({ codes: [c], to: m.to })
      const ok = r.done > 0
      beep(ok)
      setLines((l) => [{ at: Date.now(), code: c, ok, text: ok ? `${r.moved[0] ?? c} → moved${m.to === "in_transit" ? " (sending to Pathao if not sent)" : ""}` : r.errors[0] ?? "Not moved" }, ...l].slice(0, 200))
    } catch (e) {
      beep(false)
      setLines((l) => [{ at: Date.now(), code: c, ok: false, text: errMsg(e) }, ...l].slice(0, 200))
    }
  }

  const okCount = lines.filter((l) => l.ok).length
  return (
    <div className="max-w-3xl">
      <PageHeader title="Scan" sub="Scan the barcode on the printed invoice (or type the invoice number / consignment ID and press Enter)." />
      <div className="mb-3 flex flex-wrap gap-2">
        {MODES.map((x, i) => (
          <button key={x.to} type="button" onClick={() => setMode(i)}
            className={cn("rounded-full border px-3 py-1.5 text-sm", mode === i ? "border-foreground bg-foreground text-background" : "bg-card hover:bg-accent")}>
            {x.label}
          </button>
        ))}
      </div>
      <form className="rounded-lg border bg-card p-4" onSubmit={(e) => { e.preventDefault(); submit(code) }}>
        <Input
          ref={input} value={code} onChange={(e) => setCode(e.target.value)} autoFocus
          placeholder="Scan invoice barcode…" className="h-14 text-lg" data-testid="scan-input" autoComplete="off"
        />
        <p className="mt-2 text-xs text-muted-foreground">{m.hint}</p>
      </form>
      <div className="mt-4 rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
          <span className="font-medium">This session</span>
          <span className="text-muted-foreground">{okCount} moved · {lines.length - okCount} problems</span>
        </div>
        {lines.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Nothing scanned yet.</p> : (
          <ul className="divide-y" data-testid="scan-log">
            {lines.map((l) => (
              <li key={l.at + l.code} className={cn("flex items-center justify-between px-4 py-2 text-sm", l.ok ? "" : "bg-tone-red-bg")}>
                <span>{l.ok ? "✓" : "✗"} {l.text}</span>
                <span className="text-xs text-muted-foreground">{new Date(l.at).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
