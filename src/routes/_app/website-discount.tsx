import { useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Check, ChevronDown, Search, Shuffle, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { Field, PageHeader, SaveBar, Section, useDirty } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"
import { DiscountStatus, KIND_LABEL, combinationsText, kindOf, summaryLine, WebsiteTabs, type Kind } from "@/components/discount-ui"

const KINDS: Kind[] = ["products", "order", "bxgy", "shipping"]

export const Route = createFileRoute("/_app/website-discount")({
  validateSearch: (s: Record<string, unknown>): { id: string; kind?: Kind } => ({
    id: String(s.id ?? ""), ...(KINDS.includes(s.kind as Kind) ? { kind: s.kind as Kind } : {}),
  }),
  component: () => <WebsiteGuard><Editor /></WebsiteGuard>,
})

type Scope = "all" | "collections" | "products"
type Group = "products" | "order" | "shipping"
type Form = {
  kind: Kind; method: "code" | "automatic"
  code: string; title: string; type: "percent" | "amount"; value: string; scope: Scope; items: string[]
  minMode: "none" | "amount" | "qty"; minSubtotal: string; minQty: string; onlineOnly: boolean
  limitOn: boolean; usageLimit: string; oncePerCustomer: boolean
  combines: Record<Group, boolean>
  buyQty: string; buyScope: Scope; buyItems: string[]; getQty: string; getMode: "percent" | "amount" | "free"; maxOn: boolean; maxUses: string
  startsAt: string; endOn: boolean; endsAt: string; active: boolean
}

const GROUP_OF: Record<Kind, Group> = { products: "products", bxgy: "products", order: "order", shipping: "shipping" }
const GROUP_LABEL: Record<Group, string> = { products: "Product discounts", order: "Order discounts", shipping: "Shipping discounts" }
const GROUP_SHORT: Record<Group, string> = { products: "Product discount", order: "Order discount", shipping: "Shipping discount" }

// <input type="datetime-local"> works in local time ("2026-10-27T09:00")
const toLocal = (t?: number) => { if (!t) return ""; const d = new Date(t); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }
const fromLocal = (s: string) => (s ? new Date(s).getTime() : undefined)

function initial(d: Doc<"discounts"> | null, newKind?: Kind): Form {
  const kind = d ? kindOf(d) : newKind ?? "products"
  return {
    kind, method: d?.method === "automatic" ? "automatic" : "code",
    code: d && d.method !== "automatic" ? d.code : d?.code ?? "", title: d?.title ?? "",
    type: d?.type ?? "percent", value: d && kind !== "shipping" ? String(d.value) : "",
    scope: d?.scope ?? (kind === "bxgy" ? "all" : kind === "products" ? "collections" : "all"), items: d?.items ?? [],
    minMode: d?.minQty ? "qty" : d?.minSubtotal ? "amount" : "none", minSubtotal: d?.minSubtotal ? String(d.minSubtotal) : "", minQty: d?.minQty ? String(d.minQty) : "",
    onlineOnly: !!d?.onlineOnly,
    limitOn: !!d?.usageLimit, usageLimit: d?.usageLimit ? String(d.usageLimit) : "", oncePerCustomer: !!d?.oncePerCustomer,
    combines: { products: !!d?.combines?.products, order: !!d?.combines?.order, shipping: !!d?.combines?.shipping },
    buyQty: d?.buyQty ? String(d.buyQty) : kind === "bxgy" ? "1" : "", buyScope: d?.buyScope ?? "all", buyItems: d?.buyItems ?? [],
    getQty: d?.getQty ? String(d.getQty) : kind === "bxgy" ? "1" : "",
    getMode: kind === "bxgy" && d ? (d.type === "percent" && d.value >= 100 ? "free" : d.type) : "free",
    maxOn: !!d?.maxUses, maxUses: d?.maxUses ? String(d.maxUses) : "",
    startsAt: toLocal(d?.startsAt ?? Date.now()), endOn: !!d?.endsAt, endsAt: toLocal(d?.endsAt), active: d?.active ?? true,
  }
}

function Editor() {
  const { id, kind } = Route.useSearch()
  const d = useQuery(api.discounts.get, id ? { id: id as Id<"discounts"> } : "skip")
  if (id && d === undefined) return <Loading />
  if (id && d === null) return <p className="py-16 text-center text-sm text-muted-foreground">Discount not found. <Link to="/website-discounts" className="underline">Back to discounts</Link></p>
  return <DiscountForm key={id || `new-${kind ?? ""}`} d={(d as Doc<"discounts"> | undefined) ?? null} newKind={kind} />
}

function DiscountForm({ d, newKind }: { d: Doc<"discounts"> | null; newKind?: Kind }) {
  const navigate = useNavigate()
  const save = useMutation(api.discounts.save)
  const remove = useMutation(api.discounts.remove)
  const colls = useQuery(api.website.collections)
  const prods = useQuery(api.website.products)
  const start = useMemo(() => initial(d, newKind), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState<Form>(start)
  const [saved, setSaved] = useState<Form>(start)
  const { dirty, markSaved } = useDirty(f)
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const isNew = !d
  const kind = f.kind
  const group = GROUP_OF[kind]
  const auto = f.method === "automatic"

  const collOptions = useMemo(() => (colls?.collections ?? []).map((c) => ({ key: c.handle, label: c.title, sub: `${c.live} products` })), [colls])
  const prodOptions = useMemo(() => (prods ?? []).filter((p) => p.setUp && p.handle).map((p) => ({ key: p.handle as string, label: p.title, sub: p.published ? "On website" : "Hidden", image: p.image })), [prods])
  const optionsFor = (s: Scope) => (s === "collections" ? collOptions : prodOptions)
  const nameIn = (s: Scope) => (h: string) => optionsFor(s).find((o) => o.key === h)?.label ?? h

  // what the save sends (also used for the summary)
  const typeValue = (): { type: "percent" | "amount"; value: number } =>
    kind === "shipping" ? { type: "percent", value: 100 }
      : kind === "bxgy" ? (f.getMode === "free" ? { type: "percent", value: 100 } : { type: f.getMode, value: Number(f.value) || 0 })
        : { type: f.type, value: Number(f.value) || 0 }
  const tv = typeValue()
  const preview = {
    kind, ...tv, scope: kind === "order" || kind === "shipping" ? "all" as const : f.scope, items: f.items,
    minSubtotal: kind !== "bxgy" && f.minMode === "amount" ? Number(f.minSubtotal) || undefined : undefined,
    minQty: kind !== "bxgy" && f.minMode === "qty" ? Number(f.minQty) || undefined : undefined,
    onlineOnly: f.onlineOnly, oncePerCustomer: !auto && f.oncePerCustomer, usageLimit: !auto && f.limitOn ? Number(f.usageLimit) || undefined : undefined,
    buyQty: Number(f.buyQty) || undefined, buyScope: f.buyScope, buyItems: f.buyItems, getQty: Number(f.getQty) || undefined,
    maxUses: f.maxOn ? Number(f.maxUses) || undefined : undefined,
  }

  async function onSave() {
    setSaving(true)
    try {
      const newId = await save({
        id: d?._id, method: f.method, kind,
        code: auto ? (d?.method === "automatic" ? d.code : "") : f.code, title: f.title || undefined, ...tv,
        scope: preview.scope, items: preview.scope === "all" ? [] : f.items,
        minSubtotal: preview.minSubtotal ?? null, minQty: preview.minQty ?? null, onlineOnly: f.onlineOnly,
        usageLimit: auto ? null : preview.usageLimit ?? null, oncePerCustomer: !auto && f.oncePerCustomer,
        combines: { ...f.combines, [group]: false },
        ...(kind === "bxgy" ? { buyQty: Number(f.buyQty) || null, buyScope: f.buyScope, buyItems: f.buyScope === "all" ? [] : f.buyItems, getQty: Number(f.getQty) || null, maxUses: preview.maxUses ?? null } : {}),
        startsAt: fromLocal(f.startsAt) ?? null, endsAt: f.endOn ? fromLocal(f.endsAt) ?? null : null, active: f.active,
      })
      const next = { ...f, code: auto ? f.code : f.code.trim().replace(/\s+/g, " ").toUpperCase() }
      setF(next); setSaved(next); markSaved(next)
      toast.success(`${auto ? f.title.trim() : next.code} saved — works on the website within a minute`)
      if (isNew) setTimeout(() => navigate({ to: "/website-discount", search: { id: newId }, replace: true }), 0)
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }

  const status = !f.active ? "off" : f.endOn && fromLocal(f.endsAt)! <= Date.now() ? "expired" : fromLocal(f.startsAt)! > Date.now() ? "scheduled"
    : !auto && f.limitOn && Number(f.usageLimit) && (d?.usedCount ?? 0) >= Number(f.usageLimit) ? "used_up" : "active"
  const heading = auto ? f.title.trim() : f.code.trim().toUpperCase()

  const scopeRadio = (value: Scope, onChange: (s: Scope) => void, name: string, allowAll: boolean) => (
    <div className="space-y-2">
      {([["all", "Any items"], ["collections", "Specific collections"], ["products", "Specific products"]] as const).filter(([k]) => allowAll || k !== "all").map(([k, l]) => (
        <label key={k} className="flex cursor-pointer items-center gap-2.5 text-sm">
          <input type="radio" name={name} checked={value === k} onChange={() => onChange(k)} className="size-4 accent-foreground" />{l}
        </label>
      ))}
    </div>
  )

  return (
    <div className="mx-auto max-w-5xl pb-24">
      <SaveBar dirty={dirty || (isNew && !!(f.code || f.title))} saving={saving} onSave={onSave} onDiscard={() => (isNew ? navigate({ to: "/website-discounts" }) : setF(saved))} message={isNew ? "New discount" : "Unsaved changes"} />
      <WebsiteTabs active="discounts" />
      <PageHeader
        back={{ to: "/website-discounts", label: "Back to discounts" }}
        title={isNew ? "Create discount" : <span className={cn(!auto && "font-mono")}>{heading || "Discount"}</span>}
        badges={!isNew ? <DiscountStatus status={status as any} /> : undefined}
        subtitle={KIND_LABEL[kind]}
        primary={<Button size="sm" disabled={(!dirty && !isNew) || saving} onClick={onSave}>{saving ? "Saving" : "Save"}</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          <Section title={KIND_LABEL[kind]} action={<span className="text-xs text-muted-foreground">{GROUP_SHORT[group]}</span>}>
            <div className="space-y-4">
              <Field label="Method">
                <Segmented value={f.method} onChange={(v) => set("method", v as Form["method"])} options={[["code", "Discount code"], ["automatic", "Automatic discount"]]} />
              </Field>
              {auto ? (
                <Field label="Title" hint="Shoppers see this in their bag and at checkout. Applies by itself, no code needed.">
                  <Input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Eid free delivery" autoFocus={isNew} />
                </Field>
              ) : (
                <>
                  <Field label="Discount code" hint="Customers must enter this code at checkout."
                    right={<button type="button" onClick={() => set("code", randomCode())} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"><Shuffle className="size-3.5" /> Generate random code</button>}>
                    <Input value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase())} placeholder="e.g. EID10" className="h-10 font-mono text-[15px] uppercase" autoFocus={isNew} />
                  </Field>
                  <Field label="Note for the team" hint="Only staff see this, e.g. “Eid campaign on Facebook”.">
                    <Input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Optional" />
                  </Field>
                </>
              )}
            </div>
          </Section>

          {(kind === "products" || kind === "order") && (
            <Section title="Discount value">
              <div className="space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                  <Segmented value={f.type} onChange={(v) => set("type", v as Form["type"])} options={[["percent", "Percentage"], ["amount", "Fixed amount"]]} />
                  <MoneyOrPercent type={f.type} value={f.value} onChange={(v) => set("value", v)} />
                </div>
                {kind === "products" && (
                  <>
                    <Field label="Applies to">
                      {scopeRadio(f.scope, (s) => setF((x) => ({ ...x, scope: s, items: x.scope === s ? x.items : [] })), "scope", f.scope === "all")}
                    </Field>
                    {f.scope !== "all" && <Picker options={optionsFor(f.scope)} value={f.items} onChange={(v) => set("items", v)} placeholder={f.scope === "collections" ? "Search collections" : "Search products"} />}
                    {f.type === "amount" && f.scope !== "all" && <p className="text-xs text-muted-foreground">The amount comes off once per order (at most the total of the matching items).</p>}
                  </>
                )}
                {kind === "order" && <p className="text-xs text-muted-foreground">Comes off the whole bag (before delivery). If a product discount also applies, this works on what is left.</p>}
              </div>
            </Section>
          )}

          {kind === "bxgy" && (
            <>
              <Section title="Customer buys">
                <div className="space-y-4">
                  <Field label="Minimum quantity of items"><Input inputMode="numeric" value={f.buyQty} onChange={(e) => set("buyQty", e.target.value.replace(/\D/g, ""))} className="max-w-32" /></Field>
                  <Field label="Any items from">{scopeRadio(f.buyScope, (s) => setF((x) => ({ ...x, buyScope: s, buyItems: x.buyScope === s ? x.buyItems : [] })), "buyScope", true)}</Field>
                  {f.buyScope !== "all" && <Picker options={optionsFor(f.buyScope)} value={f.buyItems} onChange={(v) => set("buyItems", v)} placeholder={f.buyScope === "collections" ? "Search collections" : "Search products"} />}
                </div>
              </Section>
              <Section title="Customer gets" sub="Customers must add the items they get to their bag. The cheapest matching items get the discount.">
                <div className="space-y-4">
                  <Field label="Quantity"><Input inputMode="numeric" value={f.getQty} onChange={(e) => set("getQty", e.target.value.replace(/\D/g, ""))} className="max-w-32" /></Field>
                  <Field label="Any items from">{scopeRadio(f.scope, (s) => setF((x) => ({ ...x, scope: s, items: x.scope === s ? x.items : [] })), "scope", true)}</Field>
                  {f.scope !== "all" && <Picker options={optionsFor(f.scope)} value={f.items} onChange={(v) => set("items", v)} placeholder={f.scope === "collections" ? "Search collections" : "Search products"} />}
                  <Field label="At a discounted value">
                    <div className="space-y-2">
                      {([["percent", "Percentage"], ["amount", "Amount off each"], ["free", "Free"]] as const).map(([k, l]) => (
                        <div key={k}>
                          <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                            <input type="radio" name="getMode" checked={f.getMode === k} onChange={() => set("getMode", k)} className="size-4 accent-foreground" />{l}
                          </label>
                          {f.getMode === k && k !== "free" && <div className="mt-2 pl-6.5"><MoneyOrPercent type={k} value={f.value} onChange={(v) => set("value", v)} /></div>}
                        </div>
                      ))}
                    </div>
                  </Field>
                  <Toggle on={f.maxOn} onChange={(v) => set("maxOn", v)} label="Set a maximum number of uses per order">
                    <Input inputMode="numeric" value={f.maxUses} onChange={(e) => set("maxUses", e.target.value.replace(/\D/g, ""))} placeholder="1" className="mt-2 max-w-32" />
                  </Toggle>
                  <p className="text-xs text-muted-foreground">Pre-order pairs don't count towards this offer.</p>
                </div>
              </Section>
            </>
          )}

          {kind === "shipping" && (
            <Section title="Delivery">
              <p className="text-sm text-muted-foreground">The delivery charge (inside or outside Dhaka) comes off the order. Bags of only Bangladesh pre-orders already have no delivery charge.</p>
            </Section>
          )}

          {kind !== "bxgy" && (
            <Section title="Minimum purchase requirements">
              <div className="space-y-2">
                {([["none", "No minimum requirements"], ["amount", "Minimum purchase amount (৳)"], ["qty", "Minimum quantity of items"]] as const).map(([k, l]) => (
                  <div key={k}>
                    <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                      <input type="radio" name="minMode" checked={f.minMode === k} onChange={() => set("minMode", k)} className="size-4 accent-foreground" />{l}
                    </label>
                    {f.minMode === "amount" && k === "amount" && (
                      <div className="mt-2 pl-6.5">
                        <div className="relative max-w-48">
                          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">৳</span>
                          <Input inputMode="numeric" value={f.minSubtotal} onChange={(e) => set("minSubtotal", e.target.value.replace(/\D/g, ""))} placeholder="1500" className="pl-7" />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">The bag (before delivery) must be at least this much.</p>
                      </div>
                    )}
                    {f.minMode === "qty" && k === "qty" && (
                      <div className="mt-2 pl-6.5">
                        <Input inputMode="numeric" value={f.minQty} onChange={(e) => set("minQty", e.target.value.replace(/\D/g, ""))} placeholder="2" className="max-w-32" />
                        <p className="mt-1 text-xs text-muted-foreground">{kind === "products" ? "Counts only the items this discount applies to." : "Counts every item in the bag."}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Customer eligibility">
            <label className="flex items-center gap-2.5 text-sm"><input type="radio" checked readOnly className="size-4 accent-foreground" />All customers</label>
            <div className="mt-3">
              <Toggle on={f.onlineOnly} onChange={(v) => set("onlineOnly", v)} label="Online payment only" hint="Doesn't work with cash on delivery (like ADVANCE5)." />
            </div>
          </Section>

          {!auto && (
            <Section title="Maximum discount uses">
              <div className="space-y-4">
                <Toggle on={f.limitOn} onChange={(v) => set("limitOn", v)} label="Limit number of times this discount can be used in total">
                  <Input inputMode="numeric" value={f.usageLimit} onChange={(e) => set("usageLimit", e.target.value.replace(/\D/g, ""))} placeholder="100" className="mt-2 max-w-48" />
                </Toggle>
                <Toggle on={f.oncePerCustomer} onChange={(v) => set("oncePerCustomer", v)} label="Limit to one use per customer" hint="Checked by mobile number." />
              </div>
            </Section>
          )}

          <Section title="Combinations" sub="Only one discount of each kind applies to an order, and both discounts must allow the combination.">
            <div className="space-y-2.5">
              <p className="text-sm">This {GROUP_SHORT[group].toLowerCase()} can be combined with:</p>
              {(["products", "order", "shipping"] as const).filter((g) => g !== group).map((g) => (
                <label key={g} className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <Checkbox checked={f.combines[g]} onCheckedChange={(v) => set("combines", { ...f.combines, [g]: !!v })} />{GROUP_LABEL[g]}
                </label>
              ))}
            </div>
          </Section>

          <Section title="Active dates">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Start date"><Input type="datetime-local" value={f.startsAt} onChange={(e) => set("startsAt", e.target.value)} /></Field>
              <div>
                <label className="mb-1.5 flex items-center gap-2 text-[13px] font-medium"><Checkbox checked={f.endOn} onCheckedChange={(v) => set("endOn", !!v)} /> Set end date</label>
                {f.endOn && <Input type="datetime-local" value={f.endsAt} onChange={(e) => set("endsAt", e.target.value)} />}
              </div>
            </div>
          </Section>
        </div>

        <div className="space-y-4">
          <Section title="Summary">
            <div className="space-y-3 text-sm">
              <div className={cn("text-base font-semibold", !auto && "font-mono")}>{heading || (auto ? "No title yet" : "No discount code yet")}</div>
              <div>
                <div className="text-xs font-semibold text-muted-foreground">Type and method</div>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground"><li>{KIND_LABEL[kind]}</li><li>{auto ? "Automatic discount" : "Discount code"}</li></ul>
              </div>
              <div>
                <div className="text-xs font-semibold text-muted-foreground">Details</div>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
                  <li>{kind === "shipping" || kind === "bxgy" || f.value ? summaryLine(preview as any, nameIn(f.scope), nameIn(f.buyScope)).split(" · ")[0] : "Enter a value"}</li>
                  {preview.minSubtotal && <li>Minimum purchase of {taka(preview.minSubtotal)}</li>}
                  {preview.minQty && <li>Minimum of {preview.minQty} items</li>}
                  <li>All customers</li>
                  <li>{f.onlineOnly ? "Online payment only" : "Online payment or cash on delivery"}</li>
                  {preview.usageLimit && <li>Limit of {preview.usageLimit} uses</li>}
                  {preview.oncePerCustomer && <li>One use per customer</li>}
                  {kind === "bxgy" && preview.maxUses && <li>{preview.maxUses} use{preview.maxUses === 1 ? "" : "s"} per order</li>}
                  <li>{combinationsText({ ...f.combines, [group]: false }) ? `Combines with ${combinationsText({ ...f.combines, [group]: false }).toLowerCase()} discounts` : "Can't combine with other discounts"}</li>
                  <li>{fromLocal(f.startsAt)! > Date.now() ? `Starts ${new Date(fromLocal(f.startsAt)!).toLocaleString()}` : "Active from today"}{f.endOn && f.endsAt ? `, ends ${new Date(fromLocal(f.endsAt)!).toLocaleString()}` : ""}</li>
                </ul>
              </div>
              {!isNew && <div className="border-t pt-3 text-xs text-muted-foreground">Used <b className="text-foreground">{d?.usedCount ?? 0}</b> time{(d?.usedCount ?? 0) === 1 ? "" : "s"} on the website</div>}
            </div>
          </Section>

          <Section title="Status">
            <Segmented value={f.active ? "on" : "off"} onChange={(v) => set("active", v === "on")} options={[["on", "On"], ["off", "Off"]]} />
            <p className="mt-2 text-xs text-muted-foreground">Turn off to stop the discount without deleting it.</p>
          </Section>

          {!isNew && (
            <Section>
              <Button variant="ghost" className="w-full justify-start text-tone-red hover:bg-tone-red-bg hover:text-tone-red" onClick={() => setConfirmDel(true)}><Trash2 className="size-4" /> Delete discount</Button>
            </Section>
          )}
        </div>
      </div>

      <Dialog open={confirmDel} onOpenChange={setConfirmDel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {d?.method === "automatic" ? d?.title : d?.code}?</DialogTitle>
            <DialogDescription>Shoppers can no longer get this discount. Orders that already used it keep their discount. To pause it instead, turn it off.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDel(false)}>Cancel</Button>
            <Button variant="destructive" onClick={async () => {
              try { await remove({ id: d!._id }); markSaved(f); toast.success("Discount deleted"); setTimeout(() => navigate({ to: "/website-discounts" }), 0) } catch (e) { toast.error(errMsg(e)) }
            }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function randomCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  return Array.from({ length: 8 }, () => a[Math.floor(Math.random() * a.length)]).join("")
}

function MoneyOrPercent({ type, value, onChange }: { type: "percent" | "amount"; value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative w-40">
      {type === "amount" && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">৳</span>}
      <Input inputMode="decimal" aria-label={type === "percent" ? "Percentage off" : "Amount off"} value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))} placeholder={type === "percent" ? "10" : "150"} className={cn(type === "amount" ? "pl-7" : "pr-8")} />
      {type === "percent" && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>}
    </div>
  )
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: readonly (readonly [string, string])[] }) {
  return (
    <div className="grid max-w-sm flex-1 gap-1 rounded-lg bg-muted p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map(([k, l]) => (
        <button key={k} type="button" onClick={() => onChange(k)} className={cn("rounded-md py-1.5 text-sm font-medium transition-colors", value === k ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>{l}</button>
      ))}
    </div>
  )
}

function Toggle({ on, onChange, label, hint, children }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div>
      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox checked={on} onCheckedChange={(v) => onChange(!!v)} className="mt-0.5" />
        <span><span className="text-sm font-medium">{label}</span>{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}</span>
      </label>
      {on && children && <div className="pl-6.5">{children}</div>}
    </div>
  )
}

type Opt = { key: string; label: string; sub?: string; image?: string | null }
function Picker({ options, value, onChange, placeholder }: { options: Opt[]; value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [q, setQ] = useState("")
  const s = q.trim().toLowerCase()
  const list = options.filter((o) => !s || o.label.toLowerCase().includes(s)).slice(0, 60)
  const byKey = new Map(options.map((o) => [o.key, o] as const))
  const toggle = (k: string) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])
  return (
    <div>
      <Popover onOpenChange={(o) => !o && setQ("")}>
        <PopoverTrigger asChild>
          <button type="button" className="flex h-9 w-full items-center justify-between rounded-md border bg-background px-3 text-left text-sm text-muted-foreground hover:bg-muted/30">
            <span className="flex items-center gap-2"><Search className="size-4" />{value.length ? `${value.length} selected — add more` : placeholder}</span><ChevronDown className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[--radix-popover-trigger-width] min-w-72 p-0">
          <div className="relative border-b">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="h-9 w-full bg-transparent pl-8 pr-2 text-sm outline-none" />
          </div>
          <div className="max-h-72 overflow-auto p-1">
            {list.length === 0 && <p className="px-2 py-4 text-center text-xs text-muted-foreground">Nothing found.</p>}
            {list.map((o) => (
              <button key={o.key} type="button" onClick={() => toggle(o.key)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent">
                <span className={cn("flex size-4 shrink-0 items-center justify-center rounded border", value.includes(o.key) && "border-primary bg-primary text-primary-foreground")}>{value.includes(o.key) && <Check className="size-3" />}</span>
                {o.image !== undefined && (o.image ? <img src={o.image} alt="" className="size-7 rounded object-cover" /> : <span className="size-7 rounded bg-muted" />)}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>{o.sub && <span className="text-xs text-muted-foreground">{o.sub}</span>}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {value.map((k) => (
            <span key={k} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
              {byKey.get(k)?.label ?? <span className="text-tone-amber">{k} (not found)</span>}
              <button type="button" aria-label="Remove" onClick={() => toggle(k)} className="text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
