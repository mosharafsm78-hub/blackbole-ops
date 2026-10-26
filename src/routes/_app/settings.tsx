import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useAction, useMutation, useQuery } from "convex/react"
import { Copy, Lock } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { ALL_STATUSES, PERMISSIONS, SMS_STATUSES, STATUS_LABEL, TRANSITIONS, moveKey } from "@/convex/rules"
import { Guard, useCan } from "@/components/app-shell"
import { Loading, PageHeader, Pill } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { dateTime, errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/settings")({
  component: () => (
    <Guard perm="settings.manage">
      <SettingsPage />
    </Guard>
  ),
})

function Section({ title, sub, children }: { title: string; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-5">
      <h2 className="font-semibold">{title}</h2>
      {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

function SettingsPage() {
  const can = useCan()
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs defaultValue="shopify">
        <TabsList className="mb-4 flex-wrap">
          <TabsTrigger value="shopify">Shopify</TabsTrigger>
          <TabsTrigger value="pathao">Pathao</TabsTrigger>
          <TabsTrigger value="sms">SMS & Email</TabsTrigger>
          <TabsTrigger value="warehouses">Warehouses</TabsTrigger>
          <TabsTrigger value="team" disabled={!can("team.manage")}>{!can("team.manage") && <Lock className="size-3" />}Team</TabsTrigger>
          <TabsTrigger value="roles" disabled={!can("team.manage")}>{!can("team.manage") && <Lock className="size-3" />}Roles</TabsTrigger>
          <TabsTrigger value="general">General</TabsTrigger>
        </TabsList>
        <TabsContent value="shopify"><ShopifyTab /></TabsContent>
        <TabsContent value="pathao"><PathaoTab /></TabsContent>
        <TabsContent value="sms"><SmsTab /></TabsContent>
        <TabsContent value="warehouses"><WarehousesTab /></TabsContent>
        {can("team.manage") && <TabsContent value="team"><TeamTab /></TabsContent>}
        {can("team.manage") && <TabsContent value="roles"><RolesTab /></TabsContent>}
        <TabsContent value="general"><GeneralTab /></TabsContent>
      </Tabs>
    </div>
  )
}

// ---------------- Shopify ----------------
function ShopifyPrivateLink({ linked }: { linked: boolean }) {
  const getLink = useMutation(api.settings.shopifyLink)
  const [url, setUrl] = useState<string | null>(null)
  return (
    <Section title="Private webhook link" sub={linked ? <Pill tone="green">Created</Pill> : undefined}>
      <p className="text-sm text-muted-foreground">Use this link instead of a signing key (for webhooks created by an app or the API). Keep it private.</p>
      <div className="mt-3 flex max-w-2xl gap-2">
        {url ? (
          <>
            <Input readOnly value={url} className="font-mono text-xs" data-testid="shopify-private-link" />
            <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(url); toast.success("Link copied") }} aria-label="Copy link"><Copy className="size-4" /></Button>
          </>
        ) : (
          <Button variant="outline" onClick={async () => { try { setUrl(await getLink({})) } catch (e) { toast.error(errMsg(e)) } }}>Show private link</Button>
        )}
      </div>
    </Section>
  )
}

function ShopifyStockSync() {
  const st = useQuery(api.shopifyStock.status)
  const save = useMutation(api.shopifyStock.save)
  const test = useAction(api.shopifyStock.test)
  const [shop, setShop] = useState("")
  const [clientId, setClientId] = useState("")
  const [secret, setSecret] = useState("")
  const [on, setOn] = useState(false)
  const [map, setMap] = useState<Record<string, string>>({})
  const [shopLocs, setShopLocs] = useState<{ id: string; name: string }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const preview = useAction(api.shopifyStock.preview)
  const pushAll = useAction(api.shopifyStock.pushAll)
  const [pv, setPv] = useState<null | { total: number; same: number; notInShopify: number; changes: { sku: string; shopify: number; ops: number }[] }>(null)
  useEffect(() => {
    if (!st || loaded) return
    setShop(st.shop || "a88d34-65.myshopify.com"); setClientId(st.clientId); setOn(st.on)
    setMap(Object.fromEntries(st.warehouses.map((w) => [w._id, w.shopifyLocationId])))
    setLoaded(true)
  }, [st, loaded])
  if (!st) return null
  const doSave = async (next = on) => {
    await save({ shop, clientId, secret: secret || undefined, on: next, map: st.warehouses.map((w) => ({ id: w._id as Id<"locations">, shopifyLocationId: map[w._id] ?? "" })) })
    setSecret("")
  }
  return (
    <Section title="Live stock → Shopify" sub={st.on ? <Pill tone="green">On</Pill> : <Pill tone="gray">Off</Pill>}>
      <p className="mb-3 text-sm text-muted-foreground">Ops is the boss of stock. Every time stock changes in Ops (goods received, order approved or cancelled, return, adjustment) the website stock is set to the same number within a few seconds: available in the linked warehouses minus pairs in Pending / On Hold orders.</p>
      <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><Label>Shop domain</Label><Input value={shop} onChange={(e) => setShop(e.target.value)} placeholder="xxxx.myshopify.com" /></div>
        <div className="space-y-1.5"><Label>Client ID (Dev Dashboard app)</Label><Input value={clientId} onChange={(e) => setClientId(e.target.value)} /></div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Client secret</Label>
          <Input type="password" autoComplete="new-password" data-1p-ignore value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={st.hasSecret ? "Saved — paste a new one to replace it" : "Paste the client secret"} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={async () => {
          setBusy(true)
          try { await doSave(); const r = await test(); setShopLocs(r.locations); toast.success(`Connected to ${r.shop}`) } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
        }}>Save & test connection</Button>
      </div>
      {st.lastError && <p className="mt-2 text-xs text-tone-red">{String(st.lastError)}</p>}
      <div className="mt-4 space-y-2">
        <div className="text-sm font-medium">Which Shopify location gets the stock</div>
        {st.warehouses.map((w) => (
          <div key={w._id} className="flex max-w-2xl items-center gap-3 text-sm">
            <span className="w-56 truncate">{w.name}{w.exchange && <span className="text-xs text-muted-foreground"> (exchange)</span>}</span>
            <Select value={map[w._id] || "__none"} onValueChange={(v) => setMap((m) => ({ ...m, [w._id]: v === "__none" ? "" : v }))}>
              <SelectTrigger className="w-72"><SelectValue placeholder="Not sent to Shopify" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">Not sent to Shopify</SelectItem>
                {(shopLocs ?? []).map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                {map[w._id] && !(shopLocs ?? []).some((l) => l.id === map[w._id]) && <SelectItem value={map[w._id]}>Linked location</SelectItem>}
              </SelectContent>
            </Select>
          </div>
        ))}
        {!shopLocs && <p className="text-xs text-muted-foreground">Click “Save & test connection” to load your Shopify locations.</p>}
      </div>
      <div className="mt-4 rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
            setBusy(true)
            try { await doSave(); setPv(await preview()) } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
          }}>Preview (changes nothing)</Button>
          {st.on && <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
            setBusy(true)
            try { const r = await pushAll(); toast.success(`Shopify updated for ${r.pushed} products${r.missing ? ` · ${r.missing} SKUs not in Shopify` : ""}`) } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
          }}>Push all now</Button>}
          {st.last && <span className="text-xs text-muted-foreground">Last update {dateTime(st.last.at)} · {st.last.count} products</span>}
        </div>
        {pv && (
          <div className="mt-3 text-sm">
            <div>{pv.total} products · <b className="text-tone-green">{pv.same} already the same</b> · <b className="text-tone-red">{pv.changes.length} will change</b> · {pv.notInShopify} not in Shopify</div>
            {pv.changes.length > 0 && (
              <div className="mt-2 max-h-72 overflow-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted"><tr><th className="p-1.5 text-left">SKU</th><th className="p-1.5 text-right">Website now</th><th className="p-1.5 text-right">Will become (Ops)</th></tr></thead>
                  <tbody>{pv.changes.slice(0, 300).map((c) => <tr key={c.sku} className="border-t"><td className="p-1.5 font-mono">{c.sku}</td><td className="p-1.5 text-right">{c.shopify}</td><td className={cn("p-1.5 text-right font-semibold", c.ops < c.shopify ? "text-tone-red" : "text-tone-green")}>{c.ops}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <Switch checked={on} onCheckedChange={async (v) => { if (v && !pv) { toast.error("Click Preview first to see what will change on the website"); return } if (v && !window.confirm(`Switch on? ${pv?.changes.length ?? 0} products will change on the website now.`)) return; setOn(v); try { await doSave(v); if (v) { const r = await pushAll(); toast.success(`Live sync on — Shopify updated for ${r.pushed} products`) } else toast.success("Stock sync switched off") } catch (e) { setOn(!v); toast.error(errMsg(e)) } }} />
        Keep Shopify stock the same as Ops (live)
      </label>
      <div className="mt-2"><Button size="sm" disabled={busy} onClick={async () => { try { await doSave(); toast.success("Saved") } catch (e) { toast.error(errMsg(e)) } }}>Save</Button></div>
    </Section>
  )
}

function ShopifyTab() {
  const info = useQuery(api.settings.integrations)
  const save = useMutation(api.settings.saveShopifySecret)
  const [secret, setSecret] = useState("")
  if (!info) return <Loading />
  return (
    <div className="space-y-4">
      <Section
        title="Receive Shopify orders"
        sub={info.shopifyConnected ? <Pill tone="green">Connected</Pill> : <Pill tone="amber">Not connected yet</Pill>}
      >
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>In Shopify admin, open <b>Settings → Notifications → Webhooks</b> and click <b>Create webhook</b>.</li>
          <li>Event: <b>Order creation</b>. Format: <b>JSON</b>. Paste this URL:
            <div className="mt-1.5 flex max-w-2xl gap-2">
              <Input readOnly value={info.webhookUrl} className="font-mono text-xs" />
              <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(info.webhookUrl); toast.success("URL copied") }} aria-label="Copy URL"><Copy className="size-4" /></Button>
            </div>
          </li>
          <li>Optional: add a second webhook with event <b>Order cancellation</b> and the same URL.</li>
          <li>Shopify shows a line “Your webhooks will be signed with …”. Copy that signing key and paste it below.</li>
        </ol>
        <div className="mt-4 flex max-w-2xl gap-2">
          <Input type="password" autoComplete="new-password" data-1p-ignore value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={info.shopifyConnected ? "Saved — paste a new key to replace it" : "Webhook signing key"} />
          <Button disabled={!secret.trim()} onClick={async () => { try { await save({ secret }); setSecret(""); toast.success("Signing key saved") } catch (e) { toast.error(errMsg(e)) } }}>Save key</Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Products are matched by SKU. Keep the same SKUs in Shopify and here so stock moves automatically.</p>
      </Section>
      <ShopifyStockSync />
      <ShopifyPrivateLink linked={info.shopifyLinked} />
      <Section title="Last webhook received">
        {info.shopifyLast ? (
          <div className="text-sm">
            <Pill tone={info.shopifyLast.ok ? "green" : "red"}>{info.shopifyLast.ok ? "OK" : "Problem"}</Pill>{" "}
            <span className="text-muted-foreground">{dateTime(info.shopifyLast.at)} · {info.shopifyLast.topic}</span>
            <div className="mt-1">{info.shopifyLast.message}</div>
          </div>
        ) : <p className="text-sm text-muted-foreground">Nothing yet. Place a test order on Shopify after saving the key.</p>}
      </Section>
    </div>
  )
}

// ---------------- Pathao ----------------
function PathaoTab() {
  const info = useQuery(api.settings.integrations)
  const save = useMutation(api.settings.savePathao)
  const test = useAction(api.pathao.testConnection)
  const detectOpen = useAction(api.pathao.detectOpenOrders)
  const [detecting, setDetecting] = useState(false)
  const [env, setEnv] = useState<"sandbox" | "production">("production")
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [stores, setStores] = useState<{ id: number; name: string; active: boolean }[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (info?.pathao) { setEnv(info.pathao.env); setUsername(info.pathao.username) }
  }, [info?.pathao?.env, info?.pathao?.username])
  if (!info) return <Loading />
  const saved = !!info.pathao
  return (
    <div className="space-y-4">
      <Section
        title="Pathao merchant API"
        sub={<>Get these from the Pathao merchant panel → Developers API. {saved ? <Pill tone="green">Saved</Pill> : <Pill tone="amber">Not connected</Pill>}</>}
      >
        <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Environment</Label>
            <Select value={env} onValueChange={(v) => setEnv(v as "sandbox" | "production")}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="production">Live (real parcels)</SelectItem><SelectItem value="sandbox">Sandbox (testing)</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Client ID</Label><Input name="pathao-client-id" autoComplete="off" data-1p-ignore data-lpignore="true" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={saved ? `Saved (${info.pathao!.clientIdHint})` : ""} /></div>
          <div className="space-y-1.5"><Label>Client secret</Label><Input type="password" name="pathao-client-secret" autoComplete="new-password" data-1p-ignore data-lpignore="true" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={saved ? "Saved — leave blank to keep" : ""} /></div>
          <div className="space-y-1.5"><Label>Merchant email</Label><Input name="pathao-merchant-email" autoComplete="off" data-1p-ignore data-lpignore="true" value={username} onChange={(e) => setUsername(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Merchant password</Label><Input type="password" name="pathao-merchant-password" autoComplete="new-password" data-1p-ignore data-lpignore="true" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={saved ? "Saved — leave blank to keep" : ""} /></div>
        </div>
        <div className="mt-4 flex gap-2">
          <Button
            disabled={busy || !username || (!saved && (!clientId || !clientSecret || !password))}
            onClick={async () => {
              setBusy(true)
              try {
                await save({ env, clientId, clientSecret, username, password })
                setClientSecret(""); setPassword("")
                const s = await test({})
                setStores(s)
                toast.success("Connected to Pathao")
              } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
            }}
          >
            Save & test
          </Button>
          {saved && (
            <Button variant="outline" disabled={busy} onClick={async () => {
              setBusy(true)
              try { setStores(await test({})); toast.success("Pathao connection works") } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
            }}>Test connection</Button>
          )}
          {info.pathao && (
            <Button variant="outline" disabled={detecting} onClick={async () => {
              setDetecting(true)
              try { const r = await detectOpen({}); toast.success(`Checked ${r.checked} open orders — city/zone filled for ${r.found}`) } catch (e) { toast.error(errMsg(e)) } finally { setDetecting(false) }
            }}>{detecting ? "Detecting…" : "Detect city/zone for open orders"}</Button>
          )}
        </div>
        {stores && (
          <div className="mt-4 rounded-md bg-muted p-3 text-sm">
            <div className="font-medium">Your Pathao stores (pick one for each warehouse in the Warehouses tab):</div>
            {stores.map((s) => <div key={s.id}>#{s.id} — {s.name}{!s.active && " (inactive)"}</div>)}
          </div>
        )}
      </Section>
      <Section title="How booking works">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Orders need a Pathao city and zone (set while confirming with the customer).</li>
          <li>When an order moves to <b>Ready To Ship</b>, it is booked with Pathao automatically and gets a consignment ID.</li>
          <li>Every 30 minutes the app checks Pathao and moves parcels to In Transit, Delivered or Pending Return.</li>
          <li>If a booking fails, the reason shows on the order with a Retry button.</li>
        </ul>
      </Section>
    </div>
  )
}

// ---------------- SMS (REVE) ----------------
const SMS_WHEN: Record<string, string> = {
  pending: "Order placed", approved: "Order confirmed", ready_to_ship: "Packed", in_transit: "Sent with courier",
  delivered_paid: "Delivered", cancelled: "Cancelled",
}
function SmsTab() {
  const info = useQuery(api.admin.commSettings)
  const save = useMutation(api.admin.saveCommSettings)
  const test = useAction(api.admin.testSms)
  const testMail = useAction(api.emailNode.testEmail)
  const [em, setEm] = useState<any>(null)
  const [mailPass, setMailPass] = useState("")
  const [testTo, setTestTo] = useState("")
  const [f, setF] = useState<any>(null)
  const [apiKey, setApiKey] = useState("")
  const [secretKey, setSecretKey] = useState("")
  const [testPhone, setTestPhone] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (info && !f) setF({ ...info.sms, contact: info.contact }) }, [info, f])
  useEffect(() => { if (info && !em) setEm(info.email) }, [info, em])
  if (!info || !f || !em) return <Loading />
  const saved = info.sms.hasKeys
  const set = (patch: any) => setF({ ...f, ...patch })
  const doSave = async () => {
    setBusy(true)
    try {
      const { contact, hasKeys: _h, ...sms } = f
      const { hasPassword: _p, ...mail } = em
      await save({ sms: { ...sms, provider: "reve", apiKey: apiKey || undefined, secretKey: secretKey || undefined }, contact, email: { ...mail, port: Number(mail.port) || 465, password: mailPass || undefined } })
      setApiKey(""); setSecretKey(""); setMailPass("")
      toast.success("Settings saved")
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-4">
      <Section
        title="REVE SMS"
        sub={<>From smpp.revesms.com → Technical Details. {saved ? <Pill tone="green">Keys saved</Pill> : <Pill tone="amber">Not connected</Pill>}</>}
      >
        <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
          <div className="space-y-1.5"><Label>API key</Label><Input type="password" name="reve-api-key" autoComplete="new-password" data-1p-ignore data-lpignore="true" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={saved ? "Saved — leave blank to keep" : ""} /></div>
          <div className="space-y-1.5"><Label>Secret key</Label><Input type="password" name="reve-secret-key" autoComplete="new-password" data-1p-ignore data-lpignore="true" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder={saved ? "Saved — leave blank to keep" : ""} /></div>
          <div className="space-y-1.5"><Label>Sender ID (name customers see)</Label><Input value={f.senderId} onChange={(e) => set({ senderId: e.target.value })} /></div>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm"><Switch checked={f.enabled} onCheckedChange={(v) => set({ enabled: v })} data-testid="sms-enabled" /> Send automatic SMS to customers</label>
      </Section>

      <Section
        title="Email (same messages)"
        sub={<>Customers who gave an email get the same message by email, at the same moments. Sent from your BlackBole mailbox. {info.email.hasPassword ? <Pill tone="green">Password saved</Pill> : <Pill tone="amber">Not connected</Pill>}</>}
      >
        <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
          <div className="space-y-1.5"><Label>Send from (mailbox)</Label><Input value={em.address} onChange={(e) => setEm({ ...em, address: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>Mailbox password</Label><Input type="password" name="mailbox-password" autoComplete="new-password" data-1p-ignore data-lpignore="true" value={mailPass} onChange={(e) => setMailPass(e.target.value)} placeholder={info.email.hasPassword ? "Saved — leave blank to keep" : ""} /></div>
          <div className="space-y-1.5"><Label>Sender name</Label><Input value={em.fromName} onChange={(e) => setEm({ ...em, fromName: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>Mail server</Label><Input value={em.host} onChange={(e) => setEm({ ...em, host: e.target.value })} /></div>
          <div className="space-y-1.5"><Label>Port</Label><Input value={String(em.port)} onChange={(e) => setEm({ ...em, port: e.target.value })} inputMode="numeric" /></div>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm"><Switch checked={em.enabled} onCheckedChange={(v) => setEm({ ...em, enabled: v })} /> Send automatic emails to customers</label>
        <div className="mt-3 flex max-w-md gap-2">
          <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="your@email.com" inputMode="email" />
          <Button variant="outline" disabled={busy || !testTo} onClick={async () => {
            setBusy(true)
            try { const r = await testMail({ to: testTo }); r.ok ? toast.success("Test email sent") : toast.error(r.error ?? "Not sent") } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
          }}>Send test email</Button>
        </div>
        <div className="mt-4"><Button disabled={busy} onClick={doSave}>{busy ? "Saving…" : "Save"}</Button></div>
      </Section>

      <Section title="When to send" sub="Tick the moments a customer gets a message. Write in English (Bangla letters cost more per SMS). {name} {invoice} {amount} {courier} {tracking} {hotline} are filled in automatically.">
        <div className="space-y-3">
          {SMS_STATUSES.map((st) => {
            const on = f.statuses.includes(st)
            return (
              <div key={st} className="rounded-md border p-3">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox checked={on} onCheckedChange={(v) => set({ statuses: v ? [...f.statuses, st] : f.statuses.filter((x: string) => x !== st) })} />
                  {SMS_WHEN[st] ?? st}
                </label>
                {on && (
                  <textarea
                    className="mt-2 w-full rounded-md border bg-background p-2 text-sm" rows={2}
                    value={f.templates?.[st] ?? info.defaults[st] ?? ""}
                    onChange={(e) => set({ templates: { ...f.templates, [st]: e.target.value } })}
                  />
                )}
              </div>
            )
          })}
          <div className="flex items-center gap-2 text-sm">
            <span>{"{amount}"} means</span>
            <Select value={f.valuePreference} onValueChange={(v) => set({ valuePreference: v })}>
              <SelectTrigger className="h-8 w-48"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="total">Order total</SelectItem><SelectItem value="due">Amount to pay on delivery</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Hotline ({"{hotline}"})</Label><Input value={f.contact.hotline} onChange={(e) => set({ contact: { ...f.contact, hotline: e.target.value } })} placeholder="01805-070650" /></div>
          </div>
        </div>
        <div className="mt-4"><Button disabled={busy} onClick={doSave}>{busy ? "Saving…" : "Save SMS settings"}</Button></div>
      </Section>

      <Section title="Send a test SMS" sub="Uses the saved settings. Costs one SMS from your REVE balance.">
        <div className="flex max-w-md gap-2">
          <Input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="01XXXXXXXXX" inputMode="numeric" />
          <Button variant="outline" disabled={busy || !testPhone} onClick={async () => {
            setBusy(true)
            try { const r = await test({ phone: testPhone }); r.ok ? toast.success("Test SMS sent") : toast.error(r.error ?? "Not sent") } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
          }}>Send test</Button>
        </div>
      </Section>

      <Section title="Last messages">
        {info.recent.length === 0 ? <p className="text-sm text-muted-foreground">No SMS sent yet.</p> : (
          <div className="divide-y text-sm">
            {info.recent.map((m: any) => (
              <div key={m._id} className="flex flex-wrap items-start gap-2 py-2">
                <Pill tone={m.status === "sent" ? "green" : "red"}>{m.channel === "email" ? "Email · " : "SMS · "}{m.status === "sent" ? "Sent" : "Failed"}</Pill>
                <span className="font-medium">{m.phone}</span>
                <span className="text-muted-foreground">{dateTime(m.at)}</span>
                <span className="basis-full text-muted-foreground">{m.text}{m.error ? <span className="text-tone-red"> — {m.error}</span> : null}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

// ---------------- Warehouses ----------------
function WarehousesTab() {
  const locations = useQuery(api.team.listLocations)
  const save = useMutation(api.team.saveLocation)
  const [edit, setEdit] = useState<Partial<Doc<"locations">> | null>(null)
  if (!locations) return <Loading />
  return (
    <Section title="Warehouses" sub="Stock is kept per warehouse. Each needs a Pathao store so parcels are picked up from the right place.">
      <div className="divide-y rounded-md border">
        {locations.map((l) => (
          <div key={l._id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{l.name} {l.isDefault && <Pill tone="blue">Default</Pill>} {l.noCourier && <Pill tone="amber">Exchange · never sent to Pathao</Pill>} {!l.active && <Pill tone="gray">Inactive</Pill>}</div>
              <div className="text-xs text-muted-foreground">{l.address || "No address"} · {l.noCourier ? "Not connected to Pathao" : <>Pathao store {l.pathaoStoreId ? `#${l.pathaoStoreId}` : <span className="text-tone-red">not set</span>}</>}</div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEdit(l)}>Edit</Button>
          </div>
        ))}
      </div>
      <Button className="mt-3" variant="outline" size="sm" onClick={() => setEdit({ name: "", active: true, isDefault: false })}>Add warehouse</Button>
      {edit && (
        <Dialog open onOpenChange={(o) => !o && setEdit(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{edit._id ? "Edit warehouse" : "Add warehouse"}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5"><Label>Name</Label><Input value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Address</Label><Input value={edit.address ?? ""} onChange={(e) => setEdit({ ...edit, address: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Phone</Label><Input value={edit.phone ?? ""} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Pathao store ID</Label><Input type="number" value={edit.pathaoStoreId ?? ""} onChange={(e) => setEdit({ ...edit, pathaoStoreId: e.target.value ? Number(e.target.value) : undefined })} placeholder="From Pathao tab → Test connection" /></div>
              <label className="flex items-center gap-2 text-sm"><Switch checked={!!edit.noCourier} onCheckedChange={(v) => setEdit({ ...edit, noCourier: v, ...(v ? { isDefault: false, pathaoStoreId: undefined } : {}) })} /> Exchange warehouse — orders here are never sent to Pathao</label>
              <label className="flex items-center gap-2 text-sm"><Switch checked={!!edit.isDefault} disabled={!!edit.noCourier} onCheckedChange={(v) => setEdit({ ...edit, isDefault: v })} /> Default for new orders</label>
              <label className="flex items-center gap-2 text-sm"><Switch checked={edit.active !== false} onCheckedChange={(v) => setEdit({ ...edit, active: v })} /> Active</label>
            </div>
            <DialogFooter>
              <Button onClick={async () => {
                try {
                  await save({ id: edit._id, name: edit.name ?? "", address: edit.address || undefined, phone: edit.phone || undefined, pathaoStoreId: edit.pathaoStoreId, isDefault: !!edit.isDefault, active: edit.active !== false, noCourier: !!edit.noCourier })
                  toast.success("Warehouse saved"); setEdit(null)
                } catch (e) { toast.error(errMsg(e)) }
              }}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Section>
  )
}

// ---------------- Team ----------------
function TeamTab() {
  const staff = useQuery(api.team.listStaff)
  const roles = useQuery(api.team.listRoles)
  const requests = useQuery(api.team.listRequests)
  const save = useMutation(api.team.saveStaff)
  const approve = useMutation(api.team.approveRequest)
  const reject = useMutation(api.team.rejectRequest)
  const resetLogin = useMutation(api.team.resetStaffLogin)
  const [edit, setEdit] = useState<{ id?: Id<"staff">; email: string; name: string; phone: string; roleId?: Id<"roles">; active: boolean } | null>(null)
  const [permsFor, setPermsFor] = useState<NonNullable<typeof staff>[number] | null>(null)
  const [reqRole, setReqRole] = useState<Record<string, string>>({})
  const [reqName, setReqName] = useState<Record<string, string>>({})
  if (!staff || !roles) return <Loading />
  const assignable = roles.filter((r) => !r.permissions.includes("*"))
  return (
    <div className="space-y-4">
      {requests && requests.length > 0 && (
        <Section title={`Waiting for access (${requests.length})`} sub="These people created a password themselves. Pick their team and approve — or reject.">
          <div className="divide-y rounded-md border" data-testid="access-requests">
            {requests.map((r) => (
              <div key={r._id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                <div className="min-w-48 flex-1"><div className="text-xs text-muted-foreground">{r.email}</div>
                  <Input className="mt-1 h-8" value={reqName[r._id] ?? r.name ?? ""} onChange={(e) => setReqName({ ...reqName, [r._id]: e.target.value })} placeholder="Their name" />
                </div>
                <Select value={reqRole[r._id]} onValueChange={(v) => setReqRole({ ...reqRole, [r._id]: v })}>
                  <SelectTrigger className="h-8 w-56"><SelectValue placeholder="Choose team / role" /></SelectTrigger>
                  <SelectContent>{roles.map((x) => <SelectItem key={x._id} value={x._id}>{x.name}</SelectItem>)}</SelectContent>
                </Select>
                <Button size="sm" disabled={!reqRole[r._id]} onClick={async () => {
                  try { await approve({ id: r._id, roleId: reqRole[r._id] as Id<"roles">, name: (reqName[r._id] ?? r.name ?? "").trim() || r.email.split("@")[0] }); toast.success("Approved — they can use the app now") } catch (e) { toast.error(errMsg(e)) }
                }}>Approve</Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={async () => { await reject({ id: r._id }); toast.success("Rejected") }}>Reject</Button>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Team" sub="Each person gets a team role. Use “Permissions” to switch single things on or off for one person — anything off shows locked for them.">
        <div className="divide-y rounded-md border">
          {staff.map((s) => {
            const custom = (s.extraPerms?.length ?? 0) + (s.deniedPerms?.length ?? 0)
            return (
              <div key={s._id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{s.name} <span className="font-normal text-muted-foreground">· {s.email}</span></div>
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    <Pill tone="blue">{s.roleName}</Pill>
                    {custom > 0 && <Pill tone="violet">{custom} personal change{custom > 1 ? "s" : ""}</Pill>}
                    {!s.active && <Pill tone="gray">Disabled</Pill>}
                    {!s.joined && <Pill tone="amber">Added — hasn't signed up yet</Pill>}
                  </div>
                </div>
                {!s.isSuperAdmin && <Button variant="outline" size="sm" onClick={() => setPermsFor(s)}>Permissions</Button>}
                <Button variant="outline" size="sm" onClick={() => setEdit({ id: s._id, email: s.email, name: s.name, phone: s.phone ?? "", roleId: s.roleId, active: s.active })}>Edit</Button>
              </div>
            )
          })}
        </div>
        <Button className="mt-3" size="sm" onClick={() => setEdit({ email: "", name: "", phone: "", roleId: assignable[0]?._id, active: true })}>Add team member</Button>
        <p className="mt-2 text-xs text-muted-foreground">Or ask them to open the app and choose “First time? Create password” — they'll appear above under “Waiting for access”.</p>
      </Section>

      {edit && (
        <Dialog open onOpenChange={(o) => !o && setEdit(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{edit.id ? "Edit team member" : "Add team member"}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5"><Label>Name</Label><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Phone</Label><Input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></div>
              <div className="space-y-1.5">
                <Label>Team / role</Label>
                <Select value={edit.roleId} onValueChange={(v) => setEdit({ ...edit, roleId: v as Id<"roles"> })}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>{roles.map((r) => <SelectItem key={r._id} value={r._id}>{r.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 text-sm"><Switch checked={edit.active} onCheckedChange={(v) => setEdit({ ...edit, active: v })} /> Can use the app</label>
            </div>
            <DialogFooter className="sm:justify-between">
              {edit.id ? (
                <Button variant="outline" className="text-destructive" onClick={async () => {
                  if (!window.confirm(`Reset ${edit.name}'s login?\n\nTheir password is removed and they are signed out. Their role and history stay. They then open the app, choose “First time? Create password” with ${edit.email} and make a new password.`)) return
                  try { await resetLogin({ id: edit.id! }); toast.success("Login reset — they can create a new password now"); setEdit(null) } catch (e) { toast.error(errMsg(e)) }
                }}>Reset login (forgot password)</Button>
              ) : <span />}
              <Button disabled={!edit.roleId || !edit.email || !edit.name} onClick={async () => {
                try {
                  await save({ id: edit.id, email: edit.email, name: edit.name, phone: edit.phone || undefined, roleId: edit.roleId!, active: edit.active })
                  toast.success("Saved"); setEdit(null)
                } catch (e) { toast.error(errMsg(e)) }
              }}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {permsFor && <PersonPerms person={permsFor} onClose={() => setPermsFor(null)} />}
    </div>
  )
}

/** Switch single permissions on/off for one person, starting from their role. */
function PersonPerms({ person, onClose }: { person: { _id: Id<"staff">; name: string; roleName: string; rolePerms: string[]; perms: string[] }; onClose: () => void }) {
  const save = useMutation(api.team.setStaffPerms)
  const [on, setOn] = useState<Set<string>>(new Set(person.perms))
  const groups = [...new Set(PERMISSIONS.map((p) => p.group))]
  const role = new Set(person.rolePerms)
  const toggle = (k: string) => setOn((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const Row = ({ k, label }: { k: string; label: string }) => {
    const changed = on.has(k) !== role.has(k)
    return (
      <label className="flex items-center gap-2 py-1 text-sm">
        <Switch checked={on.has(k)} onCheckedChange={() => toggle(k)} />
        <span className={cn(!on.has(k) && "text-muted-foreground")}>{!on.has(k) && <Lock className="mr-1 inline size-3" />}{label}</span>
        {changed && <span className="rounded bg-tone-violet-bg px-1.5 text-[10px] font-semibold text-tone-violet">{on.has(k) ? "added for this person" : "turned off for this person"}</span>}
      </label>
    )
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Permissions — {person.name}</DialogTitle>
          <p className="text-sm text-muted-foreground">Starts from the <b>{person.roleName}</b> role. Switch anything on or off for {person.name} only. Off = shown locked 🔒 to them.</p>
        </DialogHeader>
        <div className="grid gap-5 md:grid-cols-2">
          {groups.map((g) => (
            <div key={g}>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g}</div>
              {PERMISSIONS.filter((p) => p.group === g).map((p) => <Row key={p.key} k={p.key} label={p.label} />)}
            </div>
          ))}
        </div>
        <div className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Order status moves</div>
        <div className="grid gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-3">
          {ALL_STATUSES.filter((f) => TRANSITIONS[f].length).map((f) => (
            <div key={f}>
              <div className="text-sm font-medium">From {STATUS_LABEL[f]}</div>
              {TRANSITIONS[f].map((t) => <Row key={t} k={moveKey(f, t)} label={`→ ${STATUS_LABEL[t]}`} />)}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOn(new Set(person.rolePerms))}>Reset to role</Button>
          <Button onClick={async () => {
            const extraPerms = [...on].filter((k) => !role.has(k))
            const deniedPerms = [...role].filter((k) => !on.has(k))
            try { await save({ id: person._id, extraPerms, deniedPerms }); toast.success(`Saved for ${person.name}`); onClose() } catch (e) { toast.error(errMsg(e)) }
          }}>Save permissions</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- Roles ----------------
function RolesTab() {
  const roles = useQuery(api.team.listRoles)
  const save = useMutation(api.team.saveRole)
  const [sel, setSel] = useState<Id<"roles"> | "new" | null>(null)
  const [name, setName] = useState("")
  const [perms, setPerms] = useState<string[]>([])
  useEffect(() => {
    if (!roles || roles.length === 0) return
    if (sel === null) { setSel(roles[1]?._id ?? roles[0]._id); return }
    if (sel === "new") return
    const r = roles.find((x) => x._id === sel)
    if (r) { setName(r.name); setPerms(r.permissions) }
  }, [roles, sel])
  if (!roles) return <Loading />
  const current = sel && sel !== "new" ? roles.find((r) => r._id === sel) : null
  const locked = !!current?.system
  const toggle = (k: string) => setPerms(perms.includes(k) ? perms.filter((p) => p !== k) : [...perms, k])
  const groups = [...new Set(PERMISSIONS.map((p) => p.group))]

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <div className="space-y-1">
        {roles.map((r) => (
          <button key={r._id} onClick={() => setSel(r._id)} className={`w-full rounded-md px-3 py-2 text-left text-sm ${sel === r._id ? "bg-foreground text-background" : "hover:bg-accent"}`}>{r.name}</button>
        ))}
        <button onClick={() => { setSel("new"); setName(""); setPerms([]) }} className="w-full rounded-md border border-dashed px-3 py-2 text-left text-sm hover:bg-accent">+ New role</button>
      </div>
      <Section title={sel === "new" ? "New role" : name} sub={locked ? "Super Admin always has every permission." : "Tick what this role can do, including each status move."}>
        <div className="mb-4 max-w-sm space-y-1.5"><Label>Role name</Label><Input value={name} onChange={(e) => setName(e.target.value)} disabled={locked} /></div>
        <div className="grid gap-4 md:grid-cols-2">
          {groups.map((g) => (
            <div key={g}>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g}</div>
              {PERMISSIONS.filter((p) => p.group === g).map((p) => (
                <label key={p.key} className="flex items-center gap-2 py-0.5 text-sm">
                  <Checkbox checked={locked || perms.includes(p.key)} disabled={locked} onCheckedChange={() => toggle(p.key)} /> {p.label}
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="mt-5 mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status moves this role can make</div>
        <div className="grid gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-3">
          {ALL_STATUSES.filter((f) => TRANSITIONS[f].length).map((f) => (
            <div key={f}>
              <div className="text-sm font-medium">From {STATUS_LABEL[f]}</div>
              {TRANSITIONS[f].map((t) => (
                <label key={t} className="flex items-center gap-2 py-0.5 text-sm">
                  <Checkbox checked={locked || perms.includes(moveKey(f, t))} disabled={locked} onCheckedChange={() => toggle(moveKey(f, t))} /> → {STATUS_LABEL[t]}
                </label>
              ))}
            </div>
          ))}
        </div>
        {!locked && (
          <Button className="mt-5" disabled={!name.trim()} onClick={async () => {
            try {
              const id = await save({ id: sel && sel !== "new" ? sel : undefined, name, permissions: perms })
              setSel(id); toast.success("Role saved")
            } catch (e) { toast.error(errMsg(e)) }
          }}>Save role</Button>
        )}
      </Section>
    </div>
  )
}

// ---------------- General ----------------
function GeneralTab() {
  const g = useQuery(api.settings.general)
  const info = useQuery(api.settings.integrations)
  const save = useMutation(api.settings.saveGeneral)
  const [f, setF] = useState<{ invoiceStart: number; feeInsideDhaka: number; feeOutsideDhaka: number; pathaoAutoBook: boolean; pathaoBookAt: "in_transit" | "ready_to_ship" | "manual" } | null>(null)
  useEffect(() => { if (g && !f) setF(g) }, [g, f])
  if (!f || !info) return <Loading />
  return (
    <Section title="General">
      <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label>First invoice number</Label>
          <Input type="number" value={f.invoiceStart} disabled={info.invoiceUsed} onChange={(e) => setF({ ...f, invoiceStart: Number(e.target.value) || 1 })} />
          <p className="text-xs text-muted-foreground">{info.invoiceUsed ? "Locked after the first order." : "Starts above Nuport's numbers so invoices never clash."}</p>
        </div>
        <div className="space-y-1.5"><Label>Delivery fee — Dhaka</Label><Input type="number" value={f.feeInsideDhaka} onChange={(e) => setF({ ...f, feeInsideDhaka: Number(e.target.value) || 0 })} /></div>
        <div className="space-y-1.5"><Label>Delivery fee — outside Dhaka</Label><Input type="number" value={f.feeOutsideDhaka} onChange={(e) => setF({ ...f, feeOutsideDhaka: Number(e.target.value) || 0 })} /></div>
      </div>
      <div className="mt-5 max-w-2xl space-y-2" data-testid="pathao-book-at">
        <Label>Send orders to Pathao when…</Label>
        <div className="grid gap-2 sm:grid-cols-3">
          {([
            ["in_transit", "Moved to In Transit", "Like Nuport. Ready To Ship = packed only."],
            ["ready_to_ship", "Moved to Ready To Ship", "Parcel ID ready before the rider comes."],
            ["manual", "Only by button", "Staff press “Push to Pathao”."],
          ] as const).map(([k, t, d]) => (
            <button key={k} type="button" onClick={() => setF({ ...f, pathaoBookAt: k })}
              className={cn("rounded-lg border p-3 text-left", f.pathaoBookAt === k ? "border-foreground bg-accent" : "hover:bg-accent/50")}>
              <div className="text-sm font-medium">{t}</div>
              <div className="text-xs text-muted-foreground">{d}</div>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">“Push to Pathao” on an order (or on many orders in the list) always works, whatever is chosen here.</p>
      </div>
      <Button className="mt-4" onClick={async () => { try { await save(f); toast.success("Saved") } catch (e) { toast.error(errMsg(e)) } }}>Save</Button>
      <WebsiteApiKey />
    </Section>
  )
}

/** Key the BlackBole website uses to send its orders into Ops (POST /api/orders). Shown once when generated. */
function WebsiteApiKey() {
  const can = useCan()
  const info = useQuery(api.admin.integrationSettings)
  const rotate = useMutation(api.admin.rotateApiKey)
  const [key, setKey] = useState<string | null>(null)
  if (!info) return null
  const make = async () => {
    if (info.apiKeyHint && !window.confirm("A key already exists. Making a new one stops the old key working. Continue?")) return
    try { setKey(await rotate({})) } catch (e) { toast.error(errMsg(e)) }
  }
  return (
    <div className="mt-8 max-w-2xl space-y-2 border-t pt-5" data-testid="website-api-key">
      <Label>Website order API key</Label>
      <p className="text-xs text-muted-foreground">The BlackBole website uses this key to send its orders into Ops. {info.apiKeyHint ? `Current key: ${info.apiKeyHint}` : "No key yet."}</p>
      {key ? (
        <div className="flex gap-2">
          <Input readOnly value={key} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button variant="outline" onClick={async () => { await navigator.clipboard.writeText(key); toast.success("Copied") }}><Copy className="size-4" />Copy</Button>
        </div>
      ) : (
        <Button variant="outline" disabled={!can("settings.manage")} onClick={make}>{info.apiKeyHint ? "Make a new key" : "Generate key"}</Button>
      )}
      {key && <p className="text-xs text-muted-foreground">Copy it now — it is shown only once.</p>}
    </div>
  )
}
