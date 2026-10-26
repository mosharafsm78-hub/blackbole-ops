import { useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ArrowLeft, ExternalLink, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { Field, PREVIEW_URL, RichText, SaveBar, Section, SeoCard, SITE_URL, StatusBadge, useDirty } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

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

type Form = { title: string; handle: string; body: string; isPublished: boolean; seoTitle: string; seoDesc: string }

function PageForm({ page }: { page: Doc<"webPages"> | null }) {
  const navigate = useNavigate()
  const save = useMutation(api.content.savePage)
  const del = useMutation(api.content.deletePage)
  const start: Form = useMemo(() => ({
    title: page?.title ?? "", handle: page?.handle ?? "", body: page?.body ?? "", isPublished: page?.isPublished ?? true,
    seoTitle: page?.seo?.title ?? "", seoDesc: page?.seo?.description ?? "",
  }), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState<Form>(start)
  const [saved, setSaved] = useState<Form>(start)
  const { dirty, markSaved } = useDirty(f)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const plain = f.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  const isNew = !page

  async function onSave() {
    if (!f.title.trim()) { toast.error("Add a title"); return }
    setSaving(true)
    try {
      const id = await save({ id: page?._id, title: f.title, handle: page ? f.handle : f.handle, body: f.body, isPublished: f.isPublished, seo: { title: f.seoTitle, description: f.seoDesc } })
      markSaved(f); setSaved(f)
      toast.success("Saved — live on the website in about 3 minutes")
      if (isNew) setTimeout(() => navigate({ to: "/website-page", search: { id }, replace: true }), 0)
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }

  return (
    <div className="mx-auto max-w-6xl pb-24">
      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onDiscard={() => setF(saved)} message={isNew ? "New page" : "Unsaved changes"} />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button size="icon" variant="outline" className="size-8" asChild><Link to="/website-pages" aria-label="Back to pages"><ArrowLeft className="size-4" /></Link></Button>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">{f.title || (isNew ? "Add page" : "Untitled page")}</h1>
        {page && <StatusBadge on={saved.isPublished} label={saved.isPublished ? "Visible" : "Hidden"} />}
        {page && <Button size="sm" variant="outline" asChild><a href={`${PREVIEW_URL}/pages/${page.handle}`} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> View</a></Button>}
        <Button size="sm" disabled={(!dirty && !isNew) || saving} onClick={onSave}>{saving ? "Saving" : "Save"}</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          <Section>
            <div className="space-y-4">
              <Field label="Title"><Input autoFocus={isNew} value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. About us" className="h-10 text-[15px]" /></Field>
              <Field label="Content"><RichText value={f.body} onChange={(v) => set("body", v)} placeholder="Write the page…" minHeight={320} /></Field>
            </div>
          </Section>
          <SeoCard site={SITE_URL} path="pages" handle={f.handle} onHandle={(v) => set("handle", v)}
            title={f.seoTitle} onTitle={(v) => set("seoTitle", v)} desc={f.seoDesc} onDesc={(v) => set("seoDesc", v)} fallbackTitle={f.title} fallbackDesc={plain} />
        </div>
        <div className="space-y-4">
          <Section title="Visibility">
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
              {[true, false].map((on) => (
                <button key={String(on)} type="button" onClick={() => set("isPublished", on)}
                  className={cn("rounded-md py-1.5 text-sm font-medium transition-colors", f.isPublished === on ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {on ? "Visible" : "Hidden"}
                </button>
              ))}
            </div>
          </Section>
          {page?.templateSuffix && (
            <Section title="Layout"><p className="text-sm text-muted-foreground">This page uses a special layout ({page.templateSuffix === "contact" ? "contact form" : page.templateSuffix}). The text you write shows above it.</p></Section>
          )}
          {page && (
            <Section>
              <Button variant="ghost" className="w-full justify-start text-tone-red hover:bg-tone-red-bg hover:text-tone-red" onClick={() => setConfirm(true)}><Trash2 className="size-4" /> Delete page</Button>
            </Section>
          )}
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
