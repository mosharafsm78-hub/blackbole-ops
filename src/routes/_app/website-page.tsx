// Website → Pages → page editor (Shopify's page editor): Title + Content on the left; Visibility (with a date),
// Template on the right; Search engine listing (with "create a URL redirect" when the web address changes).
import { useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ExternalLink, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { PAGE_TEMPLATES, RedirectNotice, VisibilityCard, fromLocalInput, toLocalInput, visibility } from "@/components/content-editor"
import { Badge, Field, PageHeader, PREVIEW_URL, RichText, SaveBar, Section, SeoCard, SITE_URL, useDirty } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { errMsg } from "@/lib/format"

export const Route = createFileRoute("/_app/website-page")({
  validateSearch: (s: Record<string, unknown>) => ({ id: String(s.id ?? "") }),
  component: () => <WebsiteGuard><TooltipProvider delayDuration={200}><Editor /></TooltipProvider></WebsiteGuard>,
})

function Editor() {
  const { id } = Route.useSearch()
  if (!id) return <PageForm key="new" page={null} />
  return <Existing id={id as Id<"webPages">} />
}
function Existing({ id }: { id: Id<"webPages"> }) {
  const page = useQuery(api.content.page, { id })
  if (page === undefined) return <Loading />
  if (page === null) return <p className="py-16 text-center text-sm text-muted-foreground">Page not found. <Link to="/website-pages" className="underline">Back to pages</Link></p>
  return <PageForm key={page._id} page={page} />
}

type Form = { title: string; handle: string; body: string; isPublished: boolean; date: string; template: string; seoTitle: string; seoDesc: string }

function PageForm({ page }: { page: Doc<"webPages"> | null }) {
  const navigate = useNavigate()
  const save = useMutation(api.content.savePage)
  const del = useMutation(api.content.deletePage)
  const start: Form = useMemo(() => {
    const t = page?.publishedAt ? Date.parse(page.publishedAt) : NaN
    return {
      title: page?.title ?? "", handle: page?.handle ?? "", body: page?.body ?? "", isPublished: page?.isPublished ?? true,
      // only a date still to come is shown in the editor (Shopify keeps the date field empty otherwise)
      date: Number.isFinite(t) && t > Date.now() ? toLocalInput(page!.publishedAt) : "",
      template: page?.templateSuffix ?? "", seoTitle: page?.seo?.title ?? "", seoDesc: page?.seo?.description ?? "",
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState<Form>(start)
  const [saved, setSaved] = useState<Form>(start)
  const { dirty, markSaved } = useDirty(f)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [redirect, setRedirect] = useState(true)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const plain = f.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  const isNew = !page
  const templates = { ...PAGE_TEMPLATES, ...(page?.templateSuffix && !PAGE_TEMPLATES[page.templateSuffix] ? { [page.templateSuffix]: page.templateSuffix } : {}) }
  const v = visibility(saved.isPublished, saved.date ? fromLocalInput(saved.date) : page?.publishedAt ?? null)

  async function onSave() {
    if (!f.title.trim()) { toast.error("Add a title"); return }
    setSaving(true)
    try {
      const id = await save({
        id: page?._id, title: f.title, handle: f.handle, body: f.body, isPublished: f.isPublished, seo: { title: f.seoTitle, description: f.seoDesc },
        publishedAt: f.date ? fromLocalInput(f.date) : null, templateSuffix: f.template || null, redirectOld: !!page && redirect,
      })
      markSaved(f); setSaved(f)
      toast.success(page && redirect && saved.handle !== f.handle ? "Saved, with a redirect from the old address" : "Saved — live on the website in about a minute")
      if (isNew) setTimeout(() => navigate({ to: "/website-page", search: { id }, replace: true }), 0)
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }

  return (
    <div className="mx-auto max-w-5xl pb-24">
      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onDiscard={() => setF(saved)} message={isNew ? "Unsaved page" : "Unsaved changes"} />
      <PageHeader title={isNew ? "Add page" : saved.title || "Untitled page"} back={{ to: "/website-pages", label: "Pages" }}
        badges={page ? <Badge tone={v.tone}>{v.label}</Badge> : undefined}
        secondary={page ? <Button size="sm" variant="outline" asChild><a href={`${PREVIEW_URL}/pages/${page.handle}`} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> View</a></Button> : undefined}
        more={page ? [{ label: "Delete page", destructive: true, icon: <Trash2 className="size-4" />, onClick: () => setConfirm(true) }] : undefined} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          <Section>
            <div className="space-y-4">
              <Field label="Title"><Input autoFocus={isNew} value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Contact us, Sizing chart, FAQs" /></Field>
              <Field label="Content"><RichText value={f.body} onChange={(x) => set("body", x)} placeholder="Write the page…" minHeight={320} /></Field>
            </div>
          </Section>
          <div>
            <SeoCard site={SITE_URL} path="pages" handle={f.handle} onHandle={(x) => set("handle", x)}
              title={f.seoTitle} onTitle={(x) => set("seoTitle", x)} desc={f.seoDesc} onDesc={(x) => set("seoDesc", x)} fallbackTitle={f.title} fallbackDesc={plain} />
            {page && f.handle && <RedirectNotice from={`/pages/${saved.handle}`} to={`/pages/${f.handle}`} checked={redirect} onChange={setRedirect} />}
          </div>
        </div>
        <div className="space-y-4">
          <VisibilityCard isPublished={f.isPublished} onPublished={(x) => set("isPublished", x)} date={f.date} onDate={(x) => set("date", x)} savedDate={page?.publishedAt} />
          <Section title="Template">
            <select value={f.template} onChange={(e) => set("template", e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
              {Object.entries(templates).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <p className="mt-2 text-xs text-muted-foreground">
              {f.template === "contact" ? "Shows the contact form, phone, WhatsApp and email under your text." : f.template === "custom-shoes" ? "Shows the “design your own pair” form under your text." : "Your text on a plain page."}
            </p>
          </Section>
        </div>
      </div>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{page?.title}”?</DialogTitle>
            <DialogDescription>The page disappears from the website. Menu links to it stop working, so update the menus too. To keep it but hide it, set it to Hidden instead.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={async () => {
              try { await del({ id: page!._id }); markSaved(f); toast.success("Page deleted"); setTimeout(() => navigate({ to: "/website-pages" }), 0) } catch (e) { toast.error(errMsg(e)) }
            }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
