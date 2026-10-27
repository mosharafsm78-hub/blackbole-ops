import { useEffect, useState } from "react"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loading, Pill } from "@/components/bits"
import { errMsg } from "@/lib/format"

/** Settings → WhatsApp: a second, dedicated number for automatic messages and two-way chat — your team's current
 *  WhatsApp Business app is never touched by this. */
export function WhatsAppSettings() {
  const data = useQuery(api.whatsapp.settings)
  const save = useMutation(api.whatsapp.saveSettings)
  const simulate = useMutation(api.whatsapp.simulateIncoming)
  const [f, setF] = useState<any>(null)
  const [token, setToken] = useState("")
  const [sim, setSim] = useState({ phone: "01700000000", name: "Test customer", text: "Hi, which item is hot right now?" })
  useEffect(() => { if (data && !f) setF(data.conf) }, [data, f])
  if (!data || !f) return <Loading />
  const set = (k: string, val: any) => setF((x: any) => ({ ...x, [k]: val }))
  const doSave = async () => {
    try { await save({ ...f, token: token || undefined }); setToken(""); toast.success("Saved") } catch (e) { toast.error(errMsg(e)) }
  }
  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">WhatsApp inbox</h2>
            <p className="text-sm text-muted-foreground">A dedicated number for two-way WhatsApp chat and automatic messages (like win-back). Your team's regular WhatsApp Business app on your current number is separate and untouched.</p>
          </div>
          <div className="flex items-center gap-2">
            {f.enabled ? <Pill tone={f.mode === "live" ? "green" : "amber"}>{f.mode === "live" ? "On · live" : "On · test mode"}</Pill> : <Pill tone="gray">Off</Pill>}
            <Switch checked={f.enabled} onCheckedChange={(v) => set("enabled", v)} />
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">Conversations</div><div className="text-xl font-semibold tabular-nums">{data.threadCount}</div></div>
          <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">Unread</div><div className="text-xl font-semibold tabular-nums">{data.unread}</div></div>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-3 font-semibold">Connect Meta's WhatsApp Business Platform</h2>
        <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Mode</Label>
            <Select value={f.mode} onValueChange={(v) => set("mode", v)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="test">Test (no real messages — try the inbox)</SelectItem><SelectItem value="live">Live (real WhatsApp)</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>This number (for your reference)</Label><Input value={f.displayNumber} onChange={(e) => set("displayNumber", e.target.value)} placeholder="e.g. 01xxxxxxxxx" /></div>
          <div className="space-y-1.5"><Label>Phone number ID (from Meta)</Label><Input value={f.phoneNumberId} onChange={(e) => set("phoneNumberId", e.target.value)} className="font-mono" /></div>
          <div className="space-y-1.5"><Label>Verify token (you choose this)</Label><Input value={f.verifyToken} onChange={(e) => set("verifyToken", e.target.value)} className="font-mono" /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Access token</Label>
            <Input type="password" autoComplete="new-password" data-1p-ignore value={token} onChange={(e) => setToken(e.target.value)} placeholder={data.hasToken ? "Saved — paste a new one to replace it" : "Permanent access token from Meta"} />
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">In Meta's WhatsApp setup, point the webhook at <span className="font-mono">{data.webhookUrl}</span> with the verify token above.</p>
        <Button className="mt-3" onClick={doSave}>Save</Button>
      </section>

      {f.mode === "test" && (
        <section className="rounded-lg border bg-card p-5">
          <h2 className="mb-1 font-semibold">Try the inbox (test mode)</h2>
          <p className="mb-3 text-sm text-muted-foreground">Pretend a customer texted in, then reply from the WhatsApp page to see the whole flow — no real number needed yet.</p>
          <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
            <div className="space-y-1.5"><Label>Phone</Label><Input value={sim.phone} onChange={(e) => setSim((x) => ({ ...x, phone: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label>Name</Label><Input value={sim.name} onChange={(e) => setSim((x) => ({ ...x, name: e.target.value }))} /></div>
            <div className="space-y-1.5 sm:col-span-3"><Label>Message</Label><Input value={sim.text} onChange={(e) => setSim((x) => ({ ...x, text: e.target.value }))} /></div>
          </div>
          <Button className="mt-3" variant="outline" onClick={() => simulate(sim).then(() => toast.success("Sent — check the WhatsApp page")).catch((e) => toast.error(errMsg(e)))}>Simulate incoming message</Button>
        </section>
      )}
    </div>
  )
}
