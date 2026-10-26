import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ChevronDown, Megaphone, Plus, Settings2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { EmptyImport, WebsiteHeader } from "@/components/content-ui"
import { Field, RichText, SaveBar, Section, useDirty, useReorder } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { TooltipProvider } from "@/components/ui/tooltip"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/website-settings")({
  component: () => <WebsiteGuard><TooltipProvider delayDuration={200}><SettingsPage /></TooltipProvider></WebsiteGuard>,
})

type S = {
  announcements: string[]
  delivery: { inside: number; outside: number }
  preOrderDays: string
  contact: { phone: string; whatsapp: string; email: string }
  social: { facebook: string; instagram: string; tiktok: string; youtube: string }
  home: { seoTitle: string; seoDescription: string; heroKicker: string; heroTitle: string; heroButton: string; heroLink: string; newCollection: string; bestCollection: string; store1Address: string; store2Address: string; hours: string }
  policies: { type: string; title: string; body: string }[]
}
const POLICY: Record<string, string> = {
  CONTACT_INFORMATION: "Contact information", PRIVACY_POLICY: "Privacy policy", REFUND_POLICY: "Return & refund policy",
  SHIPPING_POLICY: "Shipping policy", TERMS_OF_SERVICE: "Terms of service",
}

/** Fills any field missing from what was saved, so the form always has every input. */
function complete(x: any): S {
  const h = x?.home ?? {}
  return {
    announcements: Array.isArray(x?.announcements) ? x.announcements : [],
    delivery: { inside: Number(x?.delivery?.inside ?? 90), outside: Number(x?.delivery?.outside ?? 130) },
    preOrderDays: String(x?.preOrderDays ?? "15–20"),
    contact: { phone: x?.contact?.phone ?? "", whatsapp: x?.contact?.whatsapp ?? "", email: x?.contact?.email ?? "" },
    social: { facebook: x?.social?.facebook ?? "", instagram: x?.social?.instagram ?? "", tiktok: x?.social?.tiktok ?? "", youtube: x?.social?.youtube ?? "" },
    home: {
      seoTitle: h.seoTitle ?? "", seoDescription: h.seoDescription ?? "", heroKicker: h.heroKicker ?? "", heroTitle: h.heroTitle ?? "", heroButton: h.heroButton ?? "",
      heroLink: h.heroLink ?? "", newCollection: h.newCollection ?? "", bestCollection: h.bestCollection ?? "", store1Address: h.store1Address ?? "", store2Address: h.store2Address ?? "", hours: h.hours ?? "",
    },
    policies: Array.isArray(x?.policies) ? x.policies.map((p: any) => ({ type: String(p.type), title: String(p.title ?? ""), body: String(p.body ?? "") })) : [],
  }
}

function SettingsPage() {
  const saved = useQuery(api.content.settings)
  if (saved === undefined) return <Loading />
  return (
    <div className="mx-auto max-w-6xl pb-24">
      <WebsiteHeader active="settings" sub="Announcement bar, delivery charges, contact details, homepage and policies." />
      {saved === null ? (
        <EmptyImport icon={<Settings2 className="size-5" />} what="settings" title="Store settings aren't in Ops yet"
          text="The website uses the settings it had on Shopify. Copy them here once, then change anything you like." />
      ) : <SettingsForm initial={complete(saved)} />}
    </div>
  )
}

function SettingsForm({ initial }: { initial: S }) {
  const save = useMutation(api.content.saveSettings)
  const colls = useQuery(api.website.collections)
  const start = useMemo(() => initial, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState<S>(start)
  const [base, setBase] = useState<S>(start)
  const { dirty, markSaved } = useDirty(f)
  const [saving, setSaving] = useState(false)
  const up = <K extends keyof S>(k: K, v: S[K]) => setF((x) => ({ ...x, [k]: v }))
  const sub = <K extends "delivery" | "contact" | "social" | "home">(k: K, field: keyof S[K], v: any) => setF((x) => ({ ...x, [k]: { ...x[k], [field]: v } }))
  const { props, drag, over } = useReorder(f.announcements, (v) => up("announcements", v))

  async function onSave() {
    setSaving(true)
    try {
      await save({ settings: f })
      markSaved(f); setBase(f)
      toast.success("Settings saved — live on the website in about 3 minutes")
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }
  const collOptions = (colls?.collections ?? []).map((c) => c.handle)

  return (
    <div className="space-y-4">
      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onDiscard={() => setF(base)} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={<span className="flex items-center gap-2"><Megaphone className="size-4" /> Announcement bar</span>} sub="The short messages that rotate at the very top of every page.">
          <div className="space-y-2">
            {f.announcements.map((m, i) => (
              <div key={i} {...props(i)} className={cn("flex items-center gap-2", drag === i && "opacity-40", over === i && drag !== i && "rounded-md ring-2 ring-primary/30")}>
                <span className="w-5 cursor-grab text-center text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <Input value={m} maxLength={90} onChange={(e) => up("announcements", f.announcements.map((x, j) => (j === i ? e.target.value : x)))} />
                <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label="Remove message" onClick={() => up("announcements", f.announcements.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
              </div>
            ))}
            {f.announcements.length < 8 && <Button size="sm" variant="outline" onClick={() => up("announcements", [...f.announcements, ""])}><Plus className="size-4" /> Add message</Button>}
          </div>
        </Section>

        <Section title="Delivery charges" sub="Added at checkout and in the cash-on-delivery form. Bangladesh pre-orders keep their ৳90 booking instead.">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Inside Dhaka"><Money value={f.delivery.inside} onChange={(v) => sub("delivery", "inside", v)} /></Field>
            <Field label="Outside Dhaka"><Money value={f.delivery.outside} onChange={(v) => sub("delivery", "outside", v)} /></Field>
          </div>
          <div className="mt-4"><Field label="Pre-orders arrive in (days)" hint="Used when a pre-order product has no days of its own."><Input value={f.preOrderDays} onChange={(e) => up("preOrderDays", e.target.value)} placeholder="15–20" className="max-w-40" /></Field></div>
        </Section>

        <Section title="Contact" sub="Shown on the contact page, order confirmation, track-order page and error messages.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Phone"><Input value={f.contact.phone} onChange={(e) => sub("contact", "phone", e.target.value)} placeholder="01805-070650" /></Field>
            <Field label="WhatsApp" hint="Country code first, e.g. 8801805070650"><Input value={f.contact.whatsapp} onChange={(e) => sub("contact", "whatsapp", e.target.value)} /></Field>
            <Field label="Email" className="sm:col-span-2"><Input type="email" value={f.contact.email} onChange={(e) => sub("contact", "email", e.target.value)} /></Field>
          </div>
        </Section>

        <Section title="Social links" sub="The icons in the website footer.">
          <div className="grid gap-3">
            {(["facebook", "instagram", "tiktok", "youtube"] as const).map((k) => (
              <Field key={k} label={k === "tiktok" ? "TikTok" : k === "youtube" ? "YouTube" : k[0].toUpperCase() + k.slice(1)}><Input value={f.social[k]} onChange={(e) => sub("social", k, e.target.value)} placeholder="https://…" /></Field>
            ))}
          </div>
        </Section>
      </div>

      <Section title="Homepage" sub="The big photo text at the top, the product rows and how the homepage appears on Google.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Small line above the title"><Input value={f.home.heroKicker} onChange={(e) => sub("home", "heroKicker", e.target.value)} placeholder="Autumn 2026" /></Field>
          <Field label="Big title"><Input value={f.home.heroTitle} onChange={(e) => sub("home", "heroTitle", e.target.value)} placeholder="The Veyron Collection" /></Field>
          <Field label="Button text"><Input value={f.home.heroButton} onChange={(e) => sub("home", "heroButton", e.target.value)} placeholder="Discover" /></Field>
          <Field label="Button goes to"><Input value={f.home.heroLink} onChange={(e) => sub("home", "heroLink", e.target.value)} placeholder="/collections/veyron" /></Field>
          <Field label="“New In” row shows collection"><Pick value={f.home.newCollection} options={collOptions} onChange={(v) => sub("home", "newCollection", v)} /></Field>
          <Field label="“Best Sellers” row shows collection"><Pick value={f.home.bestCollection} options={collOptions} onChange={(v) => sub("home", "bestCollection", v)} /></Field>
          <Field label="Chattogram store address"><Input value={f.home.store1Address} onChange={(e) => sub("home", "store1Address", e.target.value)} /></Field>
          <Field label="Dhaka store address"><Input value={f.home.store2Address} onChange={(e) => sub("home", "store2Address", e.target.value)} /></Field>
          <Field label="Opening hours"><Input value={f.home.hours} onChange={(e) => sub("home", "hours", e.target.value)} placeholder="Open daily, 10 AM – 10 PM" /></Field>
        </div>
        <div className="mt-4 grid gap-3 border-t pt-4">
          <Field label="Homepage title on Google" right={<Count n={f.home.seoTitle.length} max={70} />}><Input value={f.home.seoTitle} onChange={(e) => sub("home", "seoTitle", e.target.value)} /></Field>
          <Field label="Homepage description on Google" right={<Count n={f.home.seoDescription.length} max={160} />}><Textarea rows={3} value={f.home.seoDescription} onChange={(e) => sub("home", "seoDescription", e.target.value)} /></Field>
        </div>
      </Section>

      <Section title="Policies" sub="The policy pages linked at checkout (/policies/…).">
        <div className="space-y-2">
          {f.policies.length === 0 && <p className="text-sm text-muted-foreground">No policies.</p>}
          {f.policies.map((p, i) => <PolicyRow key={p.type} p={p} onChange={(np) => up("policies", f.policies.map((x, j) => (j === i ? np : x)))} />)}
        </div>
      </Section>
    </div>
  )
}

function PolicyRow({ p, onChange }: { p: S["policies"][number]; onChange: (p: S["policies"][number]) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-3 py-2.5 text-left">
        <span className="text-sm font-medium">{POLICY[p.type] ?? p.title}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">{p.body ? `${p.body.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length} words` : "Empty"}<ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} /></span>
      </button>
      {open && (
        <div className="space-y-3 border-t p-3">
          <Field label="Title"><Input value={p.title} onChange={(e) => onChange({ ...p, title: e.target.value })} /></Field>
          <RichText value={p.body} onChange={(v) => onChange({ ...p, body: v })} minHeight={240} />
        </div>
      )}
    </div>
  )
}

function Money({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">৳</span>
      <Input inputMode="numeric" value={String(value)} onChange={(e) => onChange(Number(e.target.value.replace(/[^\d]/g, "")) || 0)} className="pl-6 tabular-nums" />
    </div>
  )
}

function Pick({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
      <option value="">Theme default</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

function Count({ n, max }: { n: number; max: number }) {
  return <span className={cn("text-xs tabular-nums", n > max ? "text-tone-red" : "text-muted-foreground")}>{n} / {max}</span>
}
