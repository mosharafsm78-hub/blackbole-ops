import { useMemo, useRef, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ArrowLeft, ExternalLink, ImagePlus, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { Field, PREVIEW_URL, RichText, SaveBar, Section, SeoCard, SITE_URL, StatusBadge, SuggestInput, TagInput, uploadImages, useDirty } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/website-post")({
  validateSearch: (s: Record<string, unknown>) => ({ id: String(s.id ?? "") }),
  component: () => <WebsiteGuard><TooltipProvider delayDuration={200}><Editor /></TooltipProvider></WebsiteGuard>,
})

function Editor() {
  const { id } = Route.useSearch()
  const list = useQuery(api.content.posts)
  if (list === undefined) return <Loading />
  if (!id) return <PostForm key="new" post={null} blogs={list?.blogs ?? []} authors={[...new Set<string>((list?.posts ?? []).map((p) => p.author).filter(Boolean))]} />
  return <Existing id={id as Id<"webPosts">} blogs={list?.blogs ?? []} authors={[...new Set<string>((list?.posts ?? []).map((p) => p.author).filter(Boolean))]} />
}
function Existing({ id, blogs, authors }: { id: Id<"webPosts">; blogs: { handle: string; title: string }[]; authors: string[] }) {
  const post = useQuery(api.content.post, { id })
  if (post === undefined) return <Loading />
  if (post === null) return <p className="py-16 text-center text-sm text-muted-foreground">Post not found. <Link to="/website-blog" className="underline">Back to blog</Link></p>
  return <PostForm key={post._id} post={post} blogs={blogs} authors={authors} />
}

type Image = { url: string; altText: string; width: number | null; height: number | null } | null
type Form = { title: string; handle: string; body: string; summary: string; tags: string[]; author: string; image: Image; isPublished: boolean; publishedAt: string; blogTitle: string; seoTitle: string; seoDesc: string }
const toDay = (iso?: string | null) => (iso ? iso.slice(0, 10) : "")

function PostForm({ post, blogs, authors }: { post: Doc<"webPosts"> | null; blogs: { handle: string; title: string }[]; authors: string[] }) {
  const navigate = useNavigate()
  const save = useMutation(api.content.savePost)
  const del = useMutation(api.content.deletePost)
  const uploadUrl = useMutation(api.website.uploadUrl)
  const fileUrl = useMutation(api.website.fileUrl)
  const fileRef = useRef<HTMLInputElement>(null)
  const start: Form = useMemo(() => ({
    title: post?.title ?? "", handle: post?.handle ?? "", body: post?.body ?? "", summary: post?.summary ?? "", tags: post?.tags ?? [], author: post?.author ?? "",
    image: (post?.image as Image) ?? null, isPublished: post?.isPublished ?? true, publishedAt: toDay(post?.publishedAt), blogTitle: post?.blogTitle ?? blogs[0]?.title ?? "News",
    seoTitle: post?.seo?.title ?? "", seoDesc: post?.seo?.description ?? "",
  }), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState<Form>(start)
  const [saved, setSaved] = useState<Form>(start)
  const { dirty, markSaved } = useDirty(f)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const isNew = !post
  const blogHandle = blogs.find((b) => b.title === f.blogTitle)?.handle ?? (post && post.blogTitle === f.blogTitle ? post.blogHandle : "")
  const plain = (f.summary || f.body).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()

  async function onImage(files: File[]) {
    if (!files.length) return
    setUploading(true)
    try {
      const [img] = await uploadImages(files.slice(0, 1), () => uploadUrl({}), (x) => fileUrl(x), f.title)
      if (img) set("image", { url: img.url, altText: f.title, width: img.w, height: img.h })
    } catch (e) { toast.error(errMsg(e)) } finally { setUploading(false) }
  }

  async function onSave() {
    if (!f.title.trim()) { toast.error("Add a title"); return }
    setSaving(true)
    try {
      const id = await save({
        id: post?._id, blogHandle: post && post.blogTitle === f.blogTitle ? post.blogHandle : blogHandle, blogTitle: f.blogTitle, title: f.title, handle: f.handle, body: f.body,
        summary: f.summary, tags: f.tags, author: f.author, image: f.image, isPublished: f.isPublished,
        publishedAt: f.publishedAt ? (post?.publishedAt && toDay(post.publishedAt) === f.publishedAt ? post.publishedAt : new Date(`${f.publishedAt}T10:00:00+06:00`).toISOString()) : null,
        seo: { title: f.seoTitle, description: f.seoDesc },
      })
      markSaved(f); setSaved(f)
      toast.success("Saved — live on the website in about 3 minutes")
      if (isNew) setTimeout(() => navigate({ to: "/website-post", search: { id }, replace: true }), 0)
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }

  return (
    <div className="mx-auto max-w-6xl pb-24">
      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onDiscard={() => setF(saved)} message={isNew ? "New post" : "Unsaved changes"} />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button size="icon" variant="outline" className="size-8" asChild><Link to="/website-blog" aria-label="Back to blog"><ArrowLeft className="size-4" /></Link></Button>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">{f.title || (isNew ? "Write post" : "Untitled post")}</h1>
        {post && <StatusBadge on={saved.isPublished} label={saved.isPublished ? "Visible" : "Hidden"} />}
        {post && <Button size="sm" variant="outline" asChild><a href={`${PREVIEW_URL}/blogs/${post.blogHandle}/${post.handle}`} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> View</a></Button>}
        <Button size="sm" disabled={(!dirty && !isNew) || saving} onClick={onSave}>{saving ? "Saving" : "Save"}</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <Section>
            <div className="space-y-4">
              <Field label="Title"><Input autoFocus={isNew} value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. How to choose genuine leather shoes" className="h-10 text-[15px]" /></Field>
              <Field label="Content"><RichText value={f.body} onChange={(v) => set("body", v)} placeholder="Write the post…" minHeight={360} /></Field>
            </div>
          </Section>
          <Section title="Excerpt" sub="A short summary shown on the blog page. Leave empty to use the start of the post.">
            <Textarea rows={3} value={f.summary} onChange={(e) => set("summary", e.target.value)} />
          </Section>
          <SeoCard site={SITE_URL} path={`blogs/${blogHandle || "news"}`} handle={f.handle} onHandle={(v) => set("handle", v)}
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
            <div className="mt-3"><Field label="Publish date" hint="Leave empty to use today."><Input type="date" value={f.publishedAt} onChange={(e) => set("publishedAt", e.target.value)} /></Field></div>
          </Section>
          <Section title="Featured image">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { onImage(Array.from(e.target.files ?? [])); e.target.value = "" }} />
            {f.image ? (
              <div className="group relative overflow-hidden rounded-lg border">
                <img src={f.image.url} alt={f.image.altText} className="aspect-[4/3] w-full object-cover" />
                <div className="absolute inset-x-0 bottom-0 flex gap-2 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button size="sm" variant="secondary" disabled={uploading} onClick={() => fileRef.current?.click()}>Replace</Button>
                  <Button size="sm" variant="secondary" onClick={() => set("image", null)}>Remove</Button>
                </div>
              </div>
            ) : (
              <button type="button" disabled={uploading} onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onImage(Array.from(e.dataTransfer.files).filter((x) => x.type.startsWith("image/"))) }}
                className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed text-sm text-muted-foreground hover:bg-muted/40">
                {uploading ? <Loader2 className="size-5 animate-spin" /> : <ImagePlus className="size-5" />}{uploading ? "Uploading…" : "Add image"}<span className="text-xs">or drop it here</span>
              </button>
            )}
            {f.image && <div className="mt-2"><Field label="Alt text"><Input value={f.image.altText} onChange={(e) => set("image", { ...f.image!, altText: e.target.value })} /></Field></div>}
          </Section>
          <Section title="Organization">
            <div className="space-y-4">
              <Field label="Blog" hint="Pick a blog or type a new name."><SuggestInput value={f.blogTitle} onChange={(v) => set("blogTitle", v)} suggestions={blogs.map((b) => b.title)} /></Field>
              <Field label="Author"><SuggestInput value={f.author} onChange={(v) => set("author", v)} suggestions={authors} /></Field>
              <Field label="Tags"><TagInput value={f.tags} onChange={(v) => set("tags", v)} suggestions={[]} /></Field>
            </div>
          </Section>
          {post && (
            <Section>
              <Button variant="ghost" className="w-full justify-start text-tone-red hover:bg-tone-red-bg hover:text-tone-red" onClick={() => setConfirm(true)}><Trash2 className="size-4" /> Delete post</Button>
            </Section>
          )}
        </div>
      </div>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{post?.title}”?</DialogTitle>
            <DialogDescription>The post disappears from the website. To keep it but hide it, set it to Hidden instead.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={async () => {
              try { await del({ id: post!._id }); markSaved(f); toast.success("Post deleted"); setTimeout(() => navigate({ to: "/website-blog" }), 0) } catch (e) { toast.error(errMsg(e)) }
            }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
