import { useEffect, useState } from "react"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Loading, Pill } from "@/components/bits"
import { dateTime, errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Settings → Win-back: fully automatic — a one-time buyer who never reordered gets one SMS with a discount, no one touches it. */
export function WinBackSettings() {
  const data = useQuery(api.winback.settings)
  const save = useMutation(api.winback.saveSettings)
  const [f, setF] = useState<any>(null)
  useEffect(() => { if (data && !f) setF(data.conf) }, [data, f])
  if (!data || !f) return <Loading />
  const set = (k: string, val: any) => setF((x: any) => ({ ...x, [k]: val }))
  const doSave = async () => {
    try { await save(f); toast.success("Saved") } catch (e) { toast.error(errMsg(e)) }
  }
  const starts = new Date(data.startAt)
  const started = Date.now() >= data.startAt

  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">Win-back SMS</h2>
            <p className="text-sm text-muted-foreground">A customer who ordered once, got it delivered cleanly, and never came back gets one automatic SMS with a discount code — fully automatic, no one has to send it.</p>
          </div>
          <div className="flex items-center gap-2">
            {f.enabled ? <Pill tone="green">On · automatic</Pill> : <Pill tone="gray">Off</Pill>}
            <Switch checked={f.enabled} onCheckedChange={(v) => setF((x: any) => ({ ...x, enabled: v }))} />
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{started ? "Running since" : "Starts"} {dateTime(data.startAt)}{!started && " (Asia/Dhaka) — nothing sends before then."}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Stat label="Messages sent" value={data.sentTotal} />
          <Stat label="Discount redeemed" value={data.redeemed} tone="text-tone-green" />
          <Stat label="Window" value={`${f.minDays}–${f.maxDays} days after delivery`} />
        </div>
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-3 font-semibold">Offer & timing</h2>
        <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
          <div className="space-y-1.5"><Label>Discount code</Label><Input value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase())} className="font-mono" /></div>
          <div className="space-y-1.5"><Label>Send after (days)</Label><Input type="number" value={f.minDays} onChange={(e) => set("minDays", Number(e.target.value) || 0)} /></div>
          <div className="space-y-1.5"><Label>…until (days)</Label><Input type="number" value={f.maxDays} onChange={(e) => set("maxDays", Number(e.target.value) || 0)} /></div>
        </div>
        <div className="mt-3 max-w-2xl space-y-1.5">
          <Label>Message</Label>
          <Textarea value={f.template} onChange={(e) => set("template", e.target.value)} rows={3} />
          <p className="text-xs text-muted-foreground">Use <span className="font-mono">{"{name}"}</span> and <span className="font-mono">{"{code}"}</span>. The code is ৳150 off orders over ৳1,500, one use per customer — created automatically the first time this runs.</p>
        </div>
        <Button className="mt-3" onClick={doSave}>Save</Button>
      </section>

      <section className="rounded-xl border bg-card">
        <h2 className="border-b p-3 text-sm font-semibold">Sent so far</h2>
        {data.recent.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Nothing sent yet — the next run is within the hour{!started && `, but the campaign doesn't start until ${dateTime(data.startAt)}`}.</p>
        ) : (
          <div className="divide-y">
            {data.recent.map((r: any) => (
              <div key={r._id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
                <span className="font-medium">{r.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{r.phone}</span>
                <span className="text-xs text-muted-foreground">{dateTime(r.at)}</span>
                <span className={cn("ml-auto rounded-md px-1.5 py-0.5 text-[11px] font-semibold", r.status === "sent" ? "bg-tone-green-bg text-tone-green" : "bg-tone-red-bg text-tone-red")}>
                  {r.status === "sent" ? "Sent" : `Failed${r.error ? ` · ${r.error}` : ""}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">{label}</div><div className={cn("text-xl font-semibold tabular-nums", tone)}>{value}</div></div>
}
