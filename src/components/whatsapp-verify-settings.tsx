import { useEffect, useState } from "react"
import { useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Loading, Pill } from "@/components/bits"
import { dateTime, errMsg } from "@/lib/format"

const RESULT: Record<string, string> = {
  asked: "Summary sent", confirmed: "Confirmed → Approved", cancelled: "Cancelled", address_issue: "Address/phone incomplete → team to call",
  mismatch: "Wrong number (ignored)", already: "Already handled", not_found: "Order not found", ignored: "Repeat (ignored)",
}

/** Settings → WhatsApp verify: the customer taps "Verify on WhatsApp", gets a summary, presses Confirm or Cancel. */
export function WhatsAppVerifySettings() {
  const data = useQuery(api.whatsappVerify.settings)
  const save = useMutation(api.whatsappVerify.saveSettings)
  const simulate = useMutation(api.whatsappVerify.simulate)
  const [f, setF] = useState<any>(null)
  const [sec, setSec] = useState({ token: "", verifyToken: "", appSecret: "" })
  const [inv, setInv] = useState("")
  const [replies, setReplies] = useState<string[]>([])
  useEffect(() => { if (data && !f) setF(data.conf) }, [data, f])
  if (!data || !f) return <Loading />
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }))
  const doSave = async (patch: Record<string, unknown> = {}) => {
    const next = { ...f, ...patch }
    try { await save({ ...next, token: sec.token || undefined, verifyToken: sec.verifyToken || undefined, appSecret: sec.appSecret || undefined }); setF(next); setSec({ token: "", verifyToken: "", appSecret: "" }); toast.success("Saved") } catch (e) { toast.error(errMsg(e)) }
  }
  const play = async (step: "start" | "confirm" | "cancel") => {
    try { const r = await simulate({ invoice: inv, step }); setReplies((x) => [`${step === "start" ? "Customer sends “Verify " + inv.trim() + "”" : step === "confirm" ? "Customer taps Confirm" : "Customer taps Cancel"} → ${RESULT[r.result] ?? r.result}`, ...r.replies.map((t) => `   “${t}”`), ...x]) } catch (e) { toast.error(errMsg(e)) }
  }
  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">Verify orders on WhatsApp</h2>
            <p className="text-sm text-muted-foreground">After the COD form, the customer taps “Verify on WhatsApp” and sends the ready-typed message. We reply with their order summary and two buttons. Confirm → Approved automatically, with a message that it arrives in 2–3 days, to pick up the courier's call, and that exchange is free. Cancel → Cancelled. An incomplete address is never confirmed: the team is asked to call.</p>
          </div>
          <div className="flex items-center gap-2">
            {f.enabled ? <Pill tone={f.mode === "live" ? "green" : "amber"}>{f.mode === "live" ? "On · live" : "On · test mode"}</Pill> : <Pill tone="gray">Off</Pill>}
            <Switch checked={f.enabled} onCheckedChange={(v) => void doSave({ enabled: v })} aria-label="Verification on or off" />
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label>Mode</Label>
            <div className="flex gap-2">{(["test", "live"] as const).map((m) => <Button key={m} size="sm" variant={f.mode === m ? "default" : "outline"} onClick={() => set("mode", m)}>{m === "test" ? "Test (no real messages)" : "Live"}</Button>)}</div>
          </div>
          <div className="space-y-1"><Label>Our WhatsApp business number (with 880)</Label><Input value={f.businessNumber} onChange={(e) => set("businessNumber", e.target.value)} placeholder="8801XXXXXXXXX" /></div>
          <div className="space-y-1"><Label>Phone number ID (from Meta WhatsApp Manager)</Label><Input value={f.phoneNumberId} onChange={(e) => set("phoneNumberId", e.target.value)} /></div>
          <div className="space-y-1"><Label>Access token {data.hasToken && <Pill tone="green">saved</Pill>}</Label><Input type="password" value={sec.token} onChange={(e) => setSec({ ...sec, token: e.target.value })} placeholder={data.hasToken ? "leave empty to keep" : "permanent token"} /></div>
          <div className="space-y-1"><Label>Verify token (you choose any word) {data.hasVerifyToken && <Pill tone="green">saved</Pill>}</Label><Input type="password" value={sec.verifyToken} onChange={(e) => setSec({ ...sec, verifyToken: e.target.value })} placeholder={data.hasVerifyToken ? "leave empty to keep" : ""} /></div>
          <div className="space-y-1"><Label>App secret {data.hasAppSecret && <Pill tone="green">saved</Pill>}</Label><Input type="password" value={sec.appSecret} onChange={(e) => setSec({ ...sec, appSecret: e.target.value })} placeholder={data.hasAppSecret ? "leave empty to keep" : ""} /></div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" onClick={() => void doSave()}>Save</Button></div>
        <div className="mt-4 space-y-1 rounded-md bg-muted/50 p-3 text-xs">
          <p><b>Webhook address for Meta:</b> {data.webhookUrl}</p>
          <p><b>Button link for the COD thank-you page:</b> {data.link ?? "save the business number first"} (replace {"{order number}"} with the real order number)</p>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h3 className="font-semibold">Try it as the customer (test mode)</h3>
        <p className="text-sm text-muted-foreground">Type a Pending order's number and play the customer. Nothing is sent on WhatsApp.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Input className="w-48" value={inv} onChange={(e) => setInv(e.target.value)} placeholder="BB-12345" />
          <Button size="sm" variant="outline" disabled={!inv.trim()} onClick={() => void play("start")}>Send “Verify”</Button>
          <Button size="sm" variant="outline" disabled={!inv.trim()} onClick={() => void play("confirm")}>Tap Confirm</Button>
          <Button size="sm" variant="outline" disabled={!inv.trim()} onClick={() => void play("cancel")}>Tap Cancel</Button>
        </div>
        {replies.length > 0 && <pre className="mt-3 whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs">{replies.join("\n")}</pre>}
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h3 className="font-semibold">Last 7 days</h3>
        <p className="text-sm text-muted-foreground">{data.week.asked} verifications started · {data.week.confirmed} confirmed · {data.week.cancelled} cancelled · {data.week.addressIssue} need a call · {data.week.mismatch} wrong number</p>
        <ul className="mt-2 space-y-1 text-sm">
          {data.recent.map((e) => <li key={e._id} className="flex justify-between gap-3"><span>{e.invoice || "—"} · {RESULT[e.result] ?? e.result}</span><span className="text-muted-foreground">{dateTime(e.at)}</span></li>)}
        </ul>
      </section>
    </div>
  )
}
