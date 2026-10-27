import { useEffect, useState } from "react"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { ORDER_SOURCES } from "@/convex/rules"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loading, Pill } from "@/components/bits"
import { dateTime, errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"

const RESULT: Record<string, { label: string; tone: string }> = {
  confirmed: { label: "Pressed 1 · confirmed", tone: "bg-tone-green-bg text-tone-green" },
  cancel: { label: "Pressed 2 · wants to cancel", tone: "bg-tone-red-bg text-tone-red" },
  agent: { label: "Pressed 3 · wants to talk", tone: "bg-tone-amber-bg text-tone-amber" },
  no_answer: { label: "No answer", tone: "bg-muted text-muted-foreground" },
  skipped: { label: "Skipped (handled by team)", tone: "bg-muted text-muted-foreground" },
  failed: { label: "Call failed", tone: "bg-tone-red-bg text-tone-red" },
}

/** Settings → Auto calls: automatic order confirmation calls (press 1 confirm / 2 cancel / 3 talk to us). */
export function AutoCallSettings() {
  const data = useQuery(api.autoCalls.settings)
  const save = useMutation(api.autoCalls.saveSettings)
  const simulate = useMutation(api.autoCalls.simulate)
  const callNow = useMutation(api.autoCalls.callNow)
  const [f, setF] = useState<any>(null)
  const [secret, setSecret] = useState("")
  useEffect(() => { if (data && !f) setF(data.conf) }, [data, f])
  if (!data || !f) return <Loading />
  const set = (k: string, val: any) => setF((x: any) => ({ ...x, [k]: val }))
  const doSave = async (patch: Record<string, unknown> = {}) => {
    const next = { ...f, ...patch }
    try { await save({ ...next, secret: secret || undefined }); setF(next); setSecret(""); toast.success("Saved") } catch (e) { toast.error(errMsg(e)) }
  }
  const w = data.week
  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">Automatic confirmation calls</h2>
            <p className="text-sm text-muted-foreground">A new Pending order gets a phone call in Bangla. Press 1 → Approved automatically · press 2 → wants to cancel · press 3 → talk to customer care. No answer → tried again, then left for the team.</p>
          </div>
          <div className="flex items-center gap-2">
            {f.enabled ? <Pill tone={f.mode === "live" ? "green" : "amber"}>{f.mode === "live" ? "On · live calls" : "On · test mode"}</Pill> : <Pill tone="gray">Off</Pill>}
            <Switch checked={f.enabled} onCheckedChange={(v) => doSave({ enabled: v })} />
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Stat label="Calls this week" value={w.total} />
          <Stat label="Confirmed (1)" value={w.confirmed} tone="text-tone-green" />
          <Stat label="Wants to cancel (2)" value={w.cancel} tone="text-tone-red" />
          <Stat label="Wants to talk (3)" value={w.agent} tone="text-tone-amber" />
          <Stat label="No answer" value={w.noAnswer} />
          <Stat label="Call cost" value={taka(w.cost)} />
        </div>
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-3 font-semibold">How it calls</h2>
        <div className="grid max-w-3xl gap-3 sm:grid-cols-3">
          <div className="space-y-1.5"><Label>Mode</Label>
            <Select value={f.mode} onValueChange={(v) => set("mode", v)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="test">Test (no real calls)</SelectItem><SelectItem value="live">Live (real calls)</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Call after (minutes)</Label><Input type="number" value={f.delayMin} onChange={(e) => set("delayMin", Number(e.target.value) || 0)} /></div>
          <div className="space-y-1.5"><Label>When press 2</Label>
            <Select value={f.pressTwo} onValueChange={(v) => set("pressTwo", v)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="flag">Mark "wants to cancel" (team decides)</SelectItem><SelectItem value="cancel">Cancel automatically</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Tries again if no answer</Label><Input type="number" value={f.retries} onChange={(e) => set("retries", Number(e.target.value) || 0)} /></div>
          <div className="space-y-1.5"><Label>Minutes between tries</Label><Input type="number" value={f.retryGapMin} onChange={(e) => set("retryGapMin", Number(e.target.value) || 0)} /></div>
          <div className="space-y-1.5"><Label>Orders above ৳ go to a person (0 = all)</Label><Input type="number" value={f.maxTotal} onChange={(e) => set("maxTotal", Number(e.target.value) || 0)} /></div>
          <div className="space-y-1.5"><Label>No calls from (hour)</Label><Input type="number" value={f.quietFrom} onChange={(e) => set("quietFrom", Number(e.target.value) || 0)} /></div>
          <div className="space-y-1.5"><Label>…until (hour)</Label><Input type="number" value={f.quietTo} onChange={(e) => set("quietTo", Number(e.target.value) || 0)} /></div>
        </div>
        <div className="mt-3 space-y-1.5">
          <Label>Order sources to call (none ticked = all)</Label>
          <div className="flex flex-wrap gap-2">
            {ORDER_SOURCES.map((s) => {
              const on = f.sources.includes(s)
              return (
                <button key={s} type="button" onClick={() => set("sources", on ? f.sources.filter((x: string) => x !== s) : [...f.sources, s])}
                  className={cn("rounded-full border px-2.5 py-1 text-xs", on ? "border-foreground bg-foreground text-background" : "bg-background hover:bg-accent")}>{s}</button>
              )
            })}
          </div>
        </div>
        <div className="mt-4 grid max-w-3xl gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Call server address</Label><Input value={f.serverUrl} onChange={(e) => set("serverUrl", e.target.value)} placeholder="https://calls.blackbole.com" /></div>
          <div className="space-y-1.5"><Label>Call server key</Label>
            <Input type="password" autoComplete="new-password" data-1p-ignore value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={data.hasSecret ? "Saved — paste a new one to replace it" : "Shared secret"} />
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">The call server reports results to <span className="font-mono">{data.resultUrl}</span>. Until the phone line is connected, keep Test mode: calls are "rung" here and you press 1 / 2 / 3 below to try the whole flow.</p>
        <Button className="mt-3" onClick={() => doSave()}>Save</Button>
      </section>

      <section className="rounded-lg border bg-card">
        <h2 className="border-b p-3 text-sm font-semibold">Latest calls</h2>
        {data.rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No calls yet. Switch on, then new Pending orders get a call.</p> : (
          <div className="divide-y">
            {data.rows.map((r) => {
              const res = r.result ? RESULT[r.result] : null
              return (
                <div key={r._id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
                  <span className="font-semibold text-tone-blue">{r.invoice}</span>
                  <span>{r.customer}</span>
                  <span className="font-mono text-xs text-muted-foreground">{r.phone}</span>
                  <span className="text-xs text-muted-foreground">try {Math.max(1, r.attempt)} · {dateTime(r.updatedAt)}</span>
                  {res ? <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-semibold", res.tone)}>{res.label}</span>
                    : r.status === "calling" ? <span className="rounded-md bg-tone-blue-bg px-1.5 py-0.5 text-[11px] font-semibold text-tone-blue">Ringing…</span>
                    : <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold">Waiting · {dateTime(r.nextAt)}</span>}
                  <span className="ml-auto flex gap-1">
                    {r.status === "queued" && <Button size="xs" variant="outline" onClick={() => callNow({ id: r._id as Id<"autoCalls"> }).catch((e) => toast.error(errMsg(e)))}>Call now</Button>}
                    {r.status === "calling" && f.mode === "test" && (
                      <>
                        {[["1", "Press 1"], ["2", "Press 2"], ["3", "Press 3"]].map(([d, l]) => (
                          <Button key={d} size="xs" variant="outline" onClick={() => simulate({ id: r._id as Id<"autoCalls">, result: "answered", digit: d }).catch((e) => toast.error(errMsg(e)))}>{l}</Button>
                        ))}
                        <Button size="xs" variant="ghost" onClick={() => simulate({ id: r._id as Id<"autoCalls">, result: "no_answer" }).catch((e) => toast.error(errMsg(e)))}>No answer</Button>
                      </>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">{label}</div><div className={cn("text-xl font-semibold tabular-nums", tone)}>{value}</div></div>
}
