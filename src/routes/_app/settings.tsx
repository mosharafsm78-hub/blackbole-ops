import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useAction, useMutation, useQuery } from "convex/react"
import { Copy } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { ALL_STATUSES, PERMISSIONS, STATUS_LABEL, TRANSITIONS, moveKey } from "@/convex/rules"
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
          <TabsTrigger value="warehouses">Warehouses</TabsTrigger>
          {can("team.manage") && <TabsTrigger value="team">Team</TabsTrigger>}
          {can("team.manage") && <TabsTrigger value="roles">Roles</TabsTrigger>}
          <TabsTrigger value="general">General</TabsTrigger>
        </TabsList>
        <TabsContent value="shopify"><ShopifyTab /></TabsContent>
        <TabsContent value="pathao"><PathaoTab /></TabsContent>
        <TabsContent value="warehouses"><WarehousesTab /></TabsContent>
        {can("team.manage") && <TabsContent value="team"><TeamTab /></TabsContent>}
        {can("team.manage") && <TabsContent value="roles"><RolesTab /></TabsContent>}
        <TabsContent value="general"><GeneralTab /></TabsContent>
      </Tabs>
    </div>
  )
}

// ---------------- Shopify ----------------
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
          <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={info.shopifyConnected ? "Saved — paste a new key to replace it" : "Webhook signing key"} />
          <Button disabled={!secret.trim()} onClick={async () => { try { await save({ secret }); setSecret(""); toast.success("Signing key saved") } catch (e) { toast.error(errMsg(e)) } }}>Save key</Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Products are matched by SKU. Keep the same SKUs in Shopify and here so stock moves automatically.</p>
      </Section>
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
          <div className="space-y-1.5"><Label>Client ID</Label><Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={saved ? `Saved (${info.pathao!.clientIdHint})` : ""} /></div>
          <div className="space-y-1.5"><Label>Client secret</Label><Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={saved ? "Saved — leave blank to keep" : ""} /></div>
          <div className="space-y-1.5"><Label>Merchant email</Label><Input value={username} onChange={(e) => setUsername(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Merchant password</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={saved ? "Saved — leave blank to keep" : ""} /></div>
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
              <div className="font-medium">{l.name} {l.isDefault && <Pill tone="blue">Default</Pill>} {!l.active && <Pill tone="gray">Inactive</Pill>}</div>
              <div className="text-xs text-muted-foreground">{l.address || "No address"} · Pathao store {l.pathaoStoreId ? `#${l.pathaoStoreId}` : <span className="text-tone-red">not set</span>}</div>
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
              <label className="flex items-center gap-2 text-sm"><Switch checked={!!edit.isDefault} onCheckedChange={(v) => setEdit({ ...edit, isDefault: v })} /> Default for new orders</label>
              <label className="flex items-center gap-2 text-sm"><Switch checked={edit.active !== false} onCheckedChange={(v) => setEdit({ ...edit, active: v })} /> Active</label>
            </div>
            <DialogFooter>
              <Button onClick={async () => {
                try {
                  await save({ id: edit._id, name: edit.name ?? "", address: edit.address || undefined, phone: edit.phone || undefined, pathaoStoreId: edit.pathaoStoreId, isDefault: !!edit.isDefault, active: edit.active !== false })
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
  const save = useMutation(api.team.saveStaff)
  const [edit, setEdit] = useState<{ id?: Id<"staff">; email: string; name: string; phone: string; roleId?: Id<"roles">; active: boolean } | null>(null)
  if (!staff || !roles) return <Loading />
  return (
    <Section title="Team" sub="Add someone's email, give them a role, and they sign in with a code sent to that email.">
      <div className="divide-y rounded-md border">
        {staff.map((s) => (
          <div key={s._id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{s.name} <span className="font-normal text-muted-foreground">· {s.email}</span></div>
              <div className="mt-0.5 flex gap-1.5"><Pill tone="blue">{s.roleName}</Pill>{!s.active && <Pill tone="gray">Disabled</Pill>}{!s.joined && <Pill tone="amber">Invited — not signed in yet</Pill>}</div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEdit({ id: s._id, email: s.email, name: s.name, phone: s.phone ?? "", roleId: s.roleId, active: s.active })}>Edit</Button>
          </div>
        ))}
      </div>
      <Button className="mt-3" size="sm" onClick={() => setEdit({ email: "", name: "", phone: "", roleId: roles.find((r) => r.name === "Customer Care")?._id, active: true })}>Add team member</Button>
      {edit && (
        <Dialog open onOpenChange={(o) => !o && setEdit(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{edit.id ? "Edit team member" : "Add team member"}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5"><Label>Name</Label><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></div>
              <div className="space-y-1.5"><Label>Phone</Label><Input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></div>
              <div className="space-y-1.5">
                <Label>Role</Label>
                <Select value={edit.roleId} onValueChange={(v) => setEdit({ ...edit, roleId: v as Id<"roles"> })}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>{roles.map((r) => <SelectItem key={r._id} value={r._id}>{r.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 text-sm"><Switch checked={edit.active} onCheckedChange={(v) => setEdit({ ...edit, active: v })} /> Can sign in</label>
            </div>
            <DialogFooter>
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
    </Section>
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
  const [f, setF] = useState<{ invoiceStart: number; feeInsideDhaka: number; feeOutsideDhaka: number; pathaoAutoBook: boolean } | null>(null)
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
      <label className="mt-4 flex items-center gap-2 text-sm"><Switch checked={f.pathaoAutoBook} onCheckedChange={(v) => setF({ ...f, pathaoAutoBook: v })} /> Book with Pathao automatically at Ready To Ship</label>
      <Button className="mt-4" onClick={async () => { try { await save(f); toast.success("Saved") } catch (e) { toast.error(errMsg(e)) } }}>Save</Button>
    </Section>
  )
}
