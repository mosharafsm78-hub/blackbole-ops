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

const MODES: { to: OrderStatus; label: string; hint: string; exchange?: boolean }[] = [
  { to: "in_transit", label: "Handed over → In Transit", hint: "Scan each parcel you hand to the rider. Pathao orders are sent to Pathao now if not sent yet." },
  { to: "in_transit", exchange: true, label: "Exchange handed over → In Transit", hint: "Scan each EXCHANGE parcel you hand to the rider (Pathao exchange). Only exchange orders are accepted here, so normal parcels can't get mixed in." },
  { to: "returned", label: "Return received → Returned", hint: "Scan a returned parcel in good condition. Stock goes back to Available and can be sold again." },
  { to: "damaged", label: "Return damaged → Damaged", hint: "Scan a returned parcel that came back damaged. Stock goes to Damaged, not Available." },
]

type Line = {
  at: number; code: string; ok: boolean; text: string
  label?: string; customer?: string; items?: string; status?: string
  already?: { at: number; by: string }; same?: { label: string; status: string; at: number }[]
}

// ok = one short high beep · warning (double scan / look-alike) = three quick beeps · error = long low beep
function beep(kind: "ok" | "warn" | "error") {
  try {
    const ctx = new AudioContext()
    const tones = kind === "ok" ? [[880, 0, 0.12]] : kind === "warn" ? [[520, 0, 0.12], [520, 0.18, 0.12], [520, 0.36, 0.12]] : [[220, 0, 0.35]]
    for (const [f, start, len] of tones) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.frequency.value = f
      g.gain.value = 0.18
      o.connect(g).connect(ctx.destination)
      o.start(ctx.currentTime + start)
      o.stop(ctx.currentTime + start + len)
    }
  } catch { /* sound is optional */ }
}
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
const dayTime = (t: number) => new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })

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
      const r = await fast({ codes: [c], to: m.to, exchangeOnly: m.exchange ? true : undefined })
      const d = r.details[0]
      const ok = r.done > 0
      const scannedBefore = !!d && lines.some((l) => l.label === d.label)
      const warn = !!d && (!!d.already || d.same.length > 0 || scannedBefore)
      beep(warn ? "warn" : ok ? "ok" : "error")
      const text = ok ? `${d?.label ?? c} → ${d?.status ?? "moved"}${m.to === "in_transit" ? " (sending to Pathao if not sent)" : ""}`
        : d?.already ? `${d.label} was ALREADY ${d.status} — scanned before` : r.errors[0] ?? "Not moved"
      setLines((l) => [{ at: Date.now(), code: c, ok, text, label: d?.label, customer: d?.customer, items: d?.items, status: d?.status, already: d?.already, same: d?.same }, ...l].slice(0, 300))
    } catch (e) {
      beep("error")
      setLines((l) => [{ at: Date.now(), code: c, ok: false, text: errMsg(e) }, ...l].slice(0, 200))
    }
  }

  const okCount = lines.filter((l) => l.ok).length
  const times = new Map<string, number>()
  for (const l of lines) if (l.label) times.set(l.label, (times.get(l.label) ?? 0) + 1)
  const isWarn = (l: Line) => !!l.already || (l.same?.length ?? 0) > 0 || (!!l.label && (times.get(l.label) ?? 0) > 1)
  const last = lines[0]
  return (
    <div className="max-w-3xl">
      <PageHeader title="Scan" sub="Scan the barcode on the printed invoice (or type the invoice number / consignment ID and press Enter)." />
      <div className="mb-3 flex flex-wrap gap-2">
        {MODES.map((x, i) => (
          <button key={x.label} type="button" onClick={() => setMode(i)}
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
      {last && isWarn(last) && (
        <div className="mt-4 rounded-lg border-2 border-tone-amber bg-tone-amber-bg p-4" data-testid="scan-warning">
          <div className="text-base font-bold text-tone-amber">⚠ Check this parcel — {last.label}</div>
          <ul className="mt-1 space-y-0.5 text-sm">
            {(times.get(last.label!) ?? 0) > 1 && <li>Scanned <b>{times.get(last.label!)} times</b> in this session (see the highlighted rows below).</li>}
            {last.already && <li>It was already <b>{last.status}</b> since {dayTime(last.already.at)}{last.already.by ? ` (by ${last.already.by})` : ""}. Nothing changed now.</li>}
            {last.same?.map((x) => <li key={x.label}>Same customer, same product: <b>{x.label}</b> — now <b>{x.status}</b> (made {dayTime(x.at)}). Make sure it is not packed twice.</li>)}
          </ul>
        </div>
      )}
      <div className="mt-4 rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
          <span className="font-medium">This session</span>
          <span className="text-muted-foreground">{okCount} moved · {lines.filter(isWarn).length} warnings · {lines.length - okCount} not moved</span>
        </div>
        {lines.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Nothing scanned yet.</p> : (
          <ul className="divide-y" data-testid="scan-log">
            {lines.map((l) => {
              const n = l.label ? times.get(l.label) ?? 0 : 0
              const warn = isWarn(l)
              return (
                <li key={l.at + l.code} className={cn("px-4 py-2 text-sm", warn ? "bg-tone-amber-bg" : l.ok ? "" : "bg-tone-red-bg")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{warn ? "⚠" : l.ok ? "✓" : "✗"} {l.text}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {n > 1 && <span className="rounded bg-tone-amber px-1.5 py-0.5 text-[11px] font-bold text-white">{n}× scanned</span>}
                      {l.status && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold">Now: {l.status}</span>}
                      <span className="text-xs text-muted-foreground">{time(l.at)}</span>
                    </span>
                  </div>
                  {(l.customer || l.items) && <div className="text-xs text-muted-foreground">{l.customer} · {l.items}</div>}
                  {l.already && <div className="text-xs font-medium text-tone-amber">Already {l.status} since {dayTime(l.already.at)}{l.already.by ? ` by ${l.already.by}` : ""}</div>}
                  {l.same?.map((x) => <div key={x.label} className="text-xs font-medium text-tone-amber">Same customer + same product: {x.label} ({x.status})</div>)}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
