import { useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ArrowLeft, Check, ChevronDown, Search, Shuffle, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { Field, SaveBar, Section, useDirty } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { errMsg, taka } from "@/lib/format"
import { cn } from "@/lib/utils"
import { DiscountStatus, summaryLine } from "@/components/discount-ui"

export const Route = createFileRoute("/_app/website-discount")({
  validateSearch: (s: Record<string, unknown>) => ({ id: String(s.id ?? "") }),
  component: () => <WebsiteGuard><Editor /></WebsiteGuard>,
})

type Form = {
  code: string; title: string; type: "percent" | "amount"; value: string; scope: "all" | "collections" | "products"; items: string[]
  minOn: boolean; minSubtotal: string; onlineOnly: boolean; limitOn: boolean; usageLimit: string; oncePerCustomer: boolean
  startsAt: string; endOn: boolean; endsAt: string; active: boolean
}

// <input type="datetime-local"> works in local time ("2026-10-27T09:00")
const toLocal = (t?: number) => { if (!t) return ""; const d = new Date(t); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }
const fromLocal = (s: string) => (s ? new Date(s).getTime() : undefined)

function initial(d: Doc<"discounts"> | null): Form {
  return {
    code: d?.code ?? "", title: d?.title ?? "", type: d?.type ?? "percent", value: d ? String(d.value) : "", scope: d?.scope ?? "all", items: d?.items ?? [],
    minOn: !!d?.minSubtotal, minSubtotal: d?.minSubtotal ? String(d.minSubtotal) : "", onlineOnly: !!d?.onlineOnly,
    limitOn: !!d?.usageLimit, usageLimit: d?.usageLimit ? String(d.usageLimit) : "", oncePerCustomer: !!d?.oncePerCustomer,
    startsAt: toLocal(d?.startsAt ?? Date.now()), endOn: !!d?.endsAt, endsAt: toLocal(d?.endsAt), active: d?.active ?? true,
  }
}

function Editor() {
  const { id } = Route.useSearch()
  const d = useQuery(api.discounts.get, id ? { id: id as Id<"discounts"> } : "skip")
  if (id && d === undefined) return <Loading />
  if (id && d === null) return <p className="py-16 text-center text-sm text-muted-foreground">Discount not found. <Link to="/website-discounts" className="underline">Back to discounts</Link></p>
  return <DiscountForm key={id || "new"} d={(d as Doc<"discounts"> | undefined) ?? null} />
}

function DiscountForm({ d }: { d: Doc<"discounts"> | null }) {
  const navigate = useNavigate()
  const save = useMutation(api.discounts.save)
  const remove = useMutation(api.discounts.remove)
  const colls = useQuery(api.website.collections)
  const prods = useQuery(api.website.products)
  const start = useMemo(() => initial(d), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState<Form>(start)
  const [saved, setSaved] = useState<Form>(start)
  const { dirty, markSaved } = useDirty(f)
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const isNew = !d

  const collOptions = useMemo(() => (colls?.collections ?? []).map((c) => ({ key: c.handle, label: c.title, sub: `${c.live} products` })), [colls])
  const prodOptions = useMemo(() => (prods ?? []).filter((p) => p.setUp && p.handle).map((p) => ({ key: p.handle as string, label: p.title, sub: p.published ? "On website" : "Hidden", image: p.image })), [prods])
  const nameOf = (h: string) => (f.scope === "collections" ? collOptions : prodOptions).find((o) => o.key === h)?.label ?? h

  const preview = {
    type: f.type, value: Number(f.value) || 0, scope: f.scope, items: f.items,
    minSubtotal: f.minOn ? Number(f.minSubtotal) || undefined : undefined, onlineOnly: f.onlineOnly,
    oncePerCustomer: f.oncePerCustomer, usageLimit: f.limitOn ? Number(f.usageLimit) || undefined : undefined,
  }

  async function onSave() {
    setSaving(true)
    try {
      const newId = await save({
        id: d?._id, code: f.code, title: f.title || undefined, type: f.type, value: Number(f.value), scope: f.scope, items: f.items,
        minSubtotal: f.minOn ? Number(f.minSubtotal) || null : null, onlineOnly: f.onlineOnly,
        usageLimit: f.limitOn ? Number(f.usageLimit) || null : null, oncePerCustomer: f.oncePerCustomer,
        startsAt: fromLocal(f.startsAt) ?? null, endsAt: f.endOn ? fromLocal(f.endsAt) ?? null : null, active: f.active,
      })
      const next = { ...f, code: f.code.trim().replace(/\s+/g, " ").toUpperCase() }
      setF(next); setSaved(next); markSaved(next)
      toast.success(`${next.code} saved — works on the website within a minute`)
      if (isNew) setTimeout(() => navigate({ to: "/website-discount", search: { id: newId }, replace: true }), 0)
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }

  const status = !f.active ? "off" : f.endOn && fromLocal(f.endsAt)! <= Date.now() ? "expired" : fromLocal(f.startsAt)! > Date.now() ? "scheduled"
    : f.limitOn && Number(f.usageLimit) && (d?.usedCount ?? 0) >= Number(f.usageLimit) ? "used_up" : "active"

  return (
    <div className="mx-auto max-w-5xl pb-24">
      <SaveBar dirty={dirty || isNew && !!f.code} saving={saving} onSave={onSave} onDiscard={() => (isNew ? navigate({ to: "/website-discounts" }) : setF(saved))} message={isNew ? "New discount" : "Unsaved changes"} />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button size="icon" variant="outline" className="size-8" asChild><Link to="/website-discounts" aria-label="Back to discounts"><ArrowLeft className="size-4" /></Link></Button>
        <h1 className="min-w-0 flex-1 truncate font-mono text-xl font-semibold tracking-tight">{f.code.toUpperCase() || "Create discount"}</h1>
        {!isNew && <DiscountStatus status={status as any} />}
        <Button size="sm" disabled={(!dirty && !isNew) || saving} onClick={onSave}>{saving ? "Saving" : "Save"}</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          <Section title="Discount code" sub="Shoppers type this at checkout.">
            <div className="space-y-4">
              <Field label="Code" right={<button type="button" onClick={() => set("code", randomCode())} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"><Shuffle className="size-3.5" /> Generate</button>}>
                <Input value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase())} placeholder="e.g. EID10" className="h-10 font-mono text-[15px] uppercase" autoFocus={isNew} />
              </Field>
              <Field label="Note for the team" hint="Only you see this, e.g. “Eid campaign on Facebook”.">
                <Input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Optional" />
              </Field>
            </div>
          </Section>

          <Section title="Value">
            <div className="space-y-4">
              <Segmented value={f.type} onChange={(v) => set("type", v as Form["type"])} options={[["percent", "Percentage"], ["amount", "Fixed amount"]]} />
              <Field label={f.type === "percent" ? "Percentage off" : "Amount off"}>
                <div className="relative max-w-48">
                  {f.type === "amount" && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">৳</span>}
                  <Input inputMode="decimal" value={f.value} onChange={(e) => set("value", e.target.value.replace(/[^\d.]/g, ""))} placeholder={f.type === "percent" ? "10" : "150"} className={cn(f.type === "amount" ? "pl-7" : "pr-8")} />
                  {f.type === "percent" && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>}
                </div>
              </Field>
              <Field label="Applies to">
                <div className="space-y-2">
                  {([["all", "All products"], ["collections", "Specific collections"], ["products", "Specific products"]] as const).map(([k, l]) => (
                    <label key={k} className="flex cursor-pointer items-center gap-2.5 text-sm">
                      <input type="radio" name="scope" checked={f.scope === k} onChange={() => setF((x) => ({ ...x, scope: k, items: x.scope === k ? x.items : [] }))} className="size-4 accent-foreground" />{l}
                    </label>
                  ))}
                </div>
              </Field>
              {f.scope !== "all" && (
                <Picker
                  options={f.scope === "collections" ? collOptions : prodOptions}
                  value={f.items} onChange={(v) => set("items", v)}
                  placeholder={f.scope === "collections" ? "Search collections" : "Search products"}
                />
              )}
              {f.type === "amount" && f.scope !== "all" && <p className="text-xs text-muted-foreground">The amount comes off once per order (at most the total of the matching items).</p>}
            </div>
          </Section>

          <Section title="Conditions">
            <div className="space-y-4">
              <Toggle on={f.minOn} onChange={(v) => set("minOn", v)} label="Minimum order amount" hint="The bag (before delivery) must be at least this much.">
                <div className="relative mt-2 max-w-48">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">৳</span>
                  <Input inputMode="numeric" value={f.minSubtotal} onChange={(e) => set("minSubtotal", e.target.value.replace(/\D/g, ""))} placeholder="1500" className="pl-7" />
                </div>
              </Toggle>
              <Toggle on={f.onlineOnly} onChange={(v) => set("onlineOnly", v)} label="Online payment only" hint="Doesn't work with cash on delivery (like ADVANCE5)." />
            </div>
          </Section>

          <Section title="How many times it can be used">
            <div className="space-y-4">
              <Toggle on={f.limitOn} onChange={(v) => set("limitOn", v)} label="Limit the total number of uses">
                <Input inputMode="numeric" value={f.usageLimit} onChange={(e) => set("usageLimit", e.target.value.replace(/\D/g, ""))} placeholder="100" className="mt-2 max-w-48" />
              </Toggle>
              <Toggle on={f.oncePerCustomer} onChange={(v) => set("oncePerCustomer", v)} label="One use per customer" hint="Checked by mobile number." />
            </div>
          </Section>

          <Section title="Active dates">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Starts"><Input type="datetime-local" value={f.startsAt} onChange={(e) => set("startsAt", e.target.value)} /></Field>
              <div>
                <label className="mb-1.5 flex items-center gap-2 text-[13px] font-medium"><Checkbox checked={f.endOn} onCheckedChange={(v) => set("endOn", !!v)} /> Set an end date</label>
                {f.endOn && <Input type="datetime-local" value={f.endsAt} onChange={(e) => set("endsAt", e.target.value)} />}
              </div>
            </div>
          </Section>
        </div>

        <div className="space-y-4">
          <Section title="Summary">
            <div className="space-y-3 text-sm">
              <div className="font-mono text-base font-semibold">{f.code.trim().toUpperCase() || "No code yet"}</div>
              <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                <li>{f.value ? summaryLine(preview as any, nameOf).split(" · ")[0] : "Enter a value"}</li>
                {f.scope !== "all" && f.items.length > 1 && <li className="list-none -ml-4 text-xs">{f.items.slice(0, 4).map(nameOf).join(", ")}{f.items.length > 4 ? ` +${f.items.length - 4} more` : ""}</li>}
                {preview.minSubtotal && <li>Minimum order {taka(preview.minSubtotal)}</li>}
                <li>{f.onlineOnly ? "Online payment only" : "Online payment or cash on delivery"}</li>
                {preview.usageLimit && <li>{preview.usageLimit} uses in total</li>}
                {f.oncePerCustomer && <li>One use per customer</li>}
                <li>{fromLocal(f.startsAt)! > Date.now() ? `Starts ${new Date(fromLocal(f.startsAt)!).toLocaleString()}` : "Active from today"}{f.endOn && f.endsAt ? `, ends ${new Date(fromLocal(f.endsAt)!).toLocaleString()}` : ""}</li>
              </ul>
              {!isNew && <div className="border-t pt-3 text-xs text-muted-foreground">Used <b className="text-foreground">{d?.usedCount ?? 0}</b> time{(d?.usedCount ?? 0) === 1 ? "" : "s"} on the website</div>}
            </div>
          </Section>

          <Section title="Status">
            <Segmented value={f.active ? "on" : "off"} onChange={(v) => set("active", v === "on")} options={[["on", "On"], ["off", "Off"]]} />
            <p className="mt-2 text-xs text-muted-foreground">Turn off to stop the code without deleting it.</p>
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
            <DialogTitle>Delete {d?.code}?</DialogTitle>
            <DialogDescription>Shoppers can no longer use this code. Orders that already used it keep their discount. To pause it instead, turn it off.</DialogDescription>
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

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: readonly (readonly [string, string])[] }) {
  return (
    <div className="grid max-w-sm gap-1 rounded-lg bg-muted p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
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
