import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useAction, useMutation, useQuery } from "convex/react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Guard } from "@/components/app-shell"
import { Empty, Loading, PageHeader, Pill } from "@/components/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { dateOnly, errMsg } from "@/lib/format"

export const Route = createFileRoute("/_app/delivery-partners")({
  component: () => (
    <Guard perm="partners.manage">
      <Partners />
    </Guard>
  ),
})

type Partner = NonNullable<ReturnType<typeof useQuery<typeof api.partners.list>>>[number]

function Partners() {
  const rows = useQuery(api.partners.list, { includeInactive: true })
  const deleted = useQuery(api.partners.listDeleted)
  const setActive = useMutation(api.partners.setActive)
  const remove = useMutation(api.partners.remove)
  const restore = useMutation(api.partners.restore)
  const [edit, setEdit] = useState<Partner | "new" | null>(null)
  const [showDeleted, setShowDeleted] = useState(false)

  return (
    <div>
      <PageHeader title="Delivery partners" sub="Couriers you ship with. Each is linked to a warehouse and, for Pathao, a pickup store.">
        <Button variant="outline" size="sm" onClick={() => setShowDeleted((s) => !s)}>Recycle bin ({deleted?.length ?? 0})</Button>
        <Button size="sm" onClick={() => setEdit("new")}>Add partner</Button>
      </PageHeader>
      {rows === undefined ? <Loading /> : rows.length === 0 ? (
        <Empty title="No delivery partners yet">Add Pathao or your own courier.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">ID</th><th className="p-3 font-medium">Name</th><th className="p-3 font-medium">Type</th>
                <th className="p-3 font-medium">Contact</th><th className="p-3 font-medium">Phone</th><th className="p-3 font-medium">Warehouse</th>
                <th className="p-3 font-medium">Pathao store</th><th className="p-3 font-medium">On-board</th><th className="p-3 font-medium">Active</th><th className="p-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((p) => (
                <tr key={p._id} className="hover:bg-muted/30">
                  <td className="p-3 text-muted-foreground">D-{p.code}</td>
                  <td className="p-3 font-medium">{p.name} {p.isExchange && <Pill tone="amber">Exchange</Pill>}</td>
                  <td className="p-3 capitalize">{p.provider}{p.useOwnCredentials ? " · own login" : ""}</td>
                  <td className="p-3">{p.contactPerson ?? "—"}</td>
                  <td className="p-3">{p.phone ?? "—"}</td>
                  <td className="p-3">{p.locationName || "—"}</td>
                  <td className="p-3">{p.pathaoStoreId ?? "—"}</td>
                  <td className="p-3">{dateOnly(p.createdAt)}</td>
                  <td className="p-3"><Switch checked={p.active} onCheckedChange={(v) => setActive({ id: p._id, active: v }).catch((e) => toast.error(errMsg(e)))} /></td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" onClick={() => setEdit(p)}>Edit</Button>
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove({ id: p._id }).then(() => toast.success("Moved to recycle bin"))}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showDeleted && (
        <div className="mt-4 rounded-lg border bg-card p-4">
          <h2 className="mb-2 text-sm font-semibold">Recycle bin</h2>
          {(deleted ?? []).length === 0 ? <p className="text-sm text-muted-foreground">Empty.</p> : (deleted ?? []).map((p) => (
            <div key={p._id} className="flex items-center justify-between py-1 text-sm">
              <span>D-{p.code} · {p.name}</span>
              <Button size="sm" variant="outline" onClick={() => restore({ id: p._id })}>Restore</Button>
            </div>
          ))}
        </div>
      )}
      {edit && <PartnerDialog partner={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  )
}

function PartnerDialog({ partner, onClose }: { partner: Partner | null; onClose: () => void }) {
  const save = useMutation(api.partners.save)
  const test = useAction(api.pathao.testConnection)
  const locations = useQuery(api.team.listLocations) ?? []
  const [f, setF] = useState({
    name: partner?.name ?? "",
    provider: partner?.provider ?? "pathao",
    contactPerson: partner?.contactPerson ?? "",
    phone: partner?.phone ?? "",
    locationId: (partner?.locationId ?? "") as string,
    pathaoStoreId: partner?.pathaoStoreId ? String(partner.pathaoStoreId) : "",
    isExchange: partner?.isExchange ?? false,
    active: partner?.active ?? true,
    useOwnCredentials: partner?.useOwnCredentials ?? false,
    env: "production" as "sandbox" | "production",
    clientId: "", clientSecret: "", username: "", password: "",
  })
  const [stores, setStores] = useState<{ id: number; name: string; active: boolean }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f, v: any) => setF((x) => ({ ...x, [k]: v }))

  async function submit() {
    setBusy(true)
    try {
      await save({
        id: partner?._id,
        name: f.name, provider: f.provider, contactPerson: f.contactPerson || undefined, phone: f.phone || undefined,
        locationId: (f.locationId || undefined) as Id<"locations"> | undefined,
        pathaoStoreId: f.pathaoStoreId ? Number(f.pathaoStoreId) : undefined,
        isExchange: f.isExchange, active: f.active, useOwnCredentials: f.provider === "pathao" && f.useOwnCredentials,
        credentials: f.provider === "pathao" && f.useOwnCredentials
          ? { env: f.env, clientId: f.clientId, clientSecret: f.clientSecret, username: f.username, password: f.password }
          : undefined,
      })
      toast.success("Saved")
      onClose()
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{partner ? `Edit ${partner.name}` : "Add delivery partner"}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5"><Label>Name</Label><Input value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label>Type</Label>
              <select className="h-9 rounded-md border bg-background px-2 text-sm" value={f.provider} onChange={(e) => set("provider", e.target.value)}>
                <option value="pathao">Pathao (API)</option><option value="custom">Custom courier</option>
              </select>
            </div>
            <div className="grid gap-1.5"><Label>Warehouse</Label>
              <select className="h-9 rounded-md border bg-background px-2 text-sm" value={f.locationId} onChange={(e) => set("locationId", e.target.value)}>
                <option value="">—</option>
                {locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label>Contact person</Label><Input value={f.contactPerson} onChange={(e) => set("contactPerson", e.target.value)} /></div>
            <div className="grid gap-1.5"><Label>Phone</Label><Input value={f.phone} onChange={(e) => set("phone", e.target.value)} /></div>
          </div>
          <label className="flex items-center gap-2 text-sm"><Switch checked={f.isExchange} onCheckedChange={(v) => set("isExchange", v)} /> Exchange partner</label>
          <label className="flex items-center gap-2 text-sm"><Switch checked={f.active} onCheckedChange={(v) => set("active", v)} /> Active</label>
          {f.provider === "pathao" && (
            <>
              <div className="grid gap-1.5">
                <Label>Pathao store ID</Label>
                <div className="flex gap-2">
                  <Input value={f.pathaoStoreId} onChange={(e) => set("pathaoStoreId", e.target.value.replace(/\D/g, ""))} />
                  <Button type="button" variant="outline" onClick={async () => {
                    try { setStores(await test({ partnerId: partner?._id })) } catch (e) { toast.error(errMsg(e)) }
                  }}>Find stores</Button>
                </div>
                {stores && (
                  <div className="flex flex-wrap gap-1">
                    {stores.map((s) => (
                      <Button key={s.id} type="button" size="sm" variant={String(s.id) === f.pathaoStoreId ? "default" : "outline"} onClick={() => set("pathaoStoreId", String(s.id))}>
                        {s.name} ({s.id})
                      </Button>
                    ))}
                  </div>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm"><Switch checked={f.useOwnCredentials} onCheckedChange={(v) => set("useOwnCredentials", v)} /> Use a separate Pathao login for this partner</label>
              {f.useOwnCredentials && (
                <div className="grid gap-2 rounded-md border p-3">
                  {partner?.credentialsHint && <p className="text-xs text-muted-foreground">Saved: {partner.credentialsHint}. Leave fields blank to keep them.</p>}
                  <select className="h-9 rounded-md border bg-background px-2 text-sm" value={f.env} onChange={(e) => set("env", e.target.value)}>
                    <option value="production">Production</option><option value="sandbox">Sandbox</option>
                  </select>
                  <Input placeholder="Client ID" value={f.clientId} onChange={(e) => set("clientId", e.target.value)} />
                  <Input placeholder="Client secret" type="password" value={f.clientSecret} onChange={(e) => set("clientSecret", e.target.value)} />
                  <Input placeholder="Username (email)" value={f.username} onChange={(e) => set("username", e.target.value)} />
                  <Input placeholder="Password" type="password" value={f.password} onChange={(e) => set("password", e.target.value)} />
                </div>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
