// Website → Blog posts → post editor (Shopify's blog post editor): title, content, excerpt, search listing on the
// left; visibility (with a publish date), featured image, organization (author, blog, tags) on the right.
import { useMemo, useRef, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ExternalLink, FolderOpen, ImagePlus, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { RedirectNotice, VisibilityCard, fromLocalInput, toLocalInput, visibility } from "@/components/content-editor"
import { FilePickerDialog } from "@/components/file-picker"
import { Badge, Field, PageHeader, PREVIEW_URL, RichText, SaveBar, Section, SeoCard, SITE_URL, SuggestInput, TagInput, uploadImages, useDirty } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { errMsg } from "@/lib/format"

export const Route = createFileRoute("/_app/website-post")({
  validateSearch: (s: Record<string, unknown>): { id: string; blog?: string } => ({ id: String(s.id ?? ""), ...(s.blog ? { blog: String(s.blog) } : {}) }),
  component: () => <WebsiteGuard><TooltipProvider delayDuration={200}><Editor /></TooltipProvider></WebsiteGuard>,
})

type BlogRow = { handle: string; title: string; posts: number }
type Lists = { blogs: BlogRow[]; authors: string[]; tags: string[] }

function Editor() {
  const { id, blog } = Route.useSearch()
  const list = useQuery(api.content.posts)
  const lists: Lists = useMemo(() => ({
    blogs: (list?.blogs ?? []) as BlogRow[],
    authors: [...new Set<string>((list?.posts ?? []).map((p) => p.author).filter(Boolean))].sort(),
    tags: [...new Set<string>((list?.posts ?? []).flatMap((p) => p.tags ?? []))].sort(),
  }), [list])
  if (list === undefined) return <Loading />
  if (!id) return <PostForm key="new" post={null} lists={lists} startBlog={blog} />
  return <Existing id={id as Id<"webPosts">} lists={lists} />
}
function Existing({ id, lists }: { id: Id<"webPosts">; lists: Lists }) {
  const post = useQuery(api.content.post, { id })
  if (post === undefined) return <Loading />
  if (post === null) return <p className="py-16 text-center text-sm text-muted-foreground">Post not found. <Link to="/website-blog" className="underline">Back to blog posts</Link></p>
  return <PostForm key={post._id} post={post} lists={lists} />
}

type Image = { url: string; altText: string; width: number | null; height: number | null } | null
type Form = { title: string; handle: string; body: string; summary: string; tags: string[]; author: string; image: Image; isPublished: boolean; date: string; blogHandle: string; newBlog: string; seoTitle: string; seoDesc: string }
const NEW = "__new__"

function PostForm({ post, lists, startBlog }: { post: Doc<"webPosts"> | null; lists: Lists; startBlog?: string }) {
  const navigate = useNavigate()
  const save = useMutation(api.content.savePost)
  const del = useMutation(api.content.deletePost)
  const uploadUrl = useMutation(api.website.uploadUrl)
  const fileUrl = useMutation(api.website.fileUrl)
  const fileRef = useRef<HTMLInputElement>(null)
  const { blogs, authors, tags } = lists
  const start: Form = useMemo(() => ({
    title: post?.title ?? "", handle: post?.handle ?? "", body: post?.body ?? "", summary: post?.summary ?? "", tags: post?.tags ?? [], author: post?.author ?? "",
    image: (post?.image as Image) ?? null, isPublished: post?.isPublished ?? true, date: toLocalInput(post?.publishedAt),
    blogHandle: post?.blogHandle ?? (startBlog && blogs.some((b) => b.handle === startBlog) ? startBlog : blogs[0]?.handle ?? NEW), newBlog: blogs.length ? "" : "News",
    seoTitle: post?.seo?.title ?? "", seoDesc: post?.seo?.description ?? "",
  }), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState<Form>(start)
  const [saved, setSaved] = useState<Form>(start)
  const { dirty, markSaved } = useDirty(f)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [picker, setPicker] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [redirect, setRedirect] = useState(true)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const isNew = !post
  const isNewBlog = f.blogHandle === NEW
  const blogTitle = isNewBlog ? f.newBlog.trim() : blogs.find((b) => b.handle === f.blogHandle)?.title ?? post?.blogTitle ?? ""
  const pathBlog = isNewBlog ? (f.newBlog.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "news") : f.blogHandle
  const plain = (f.summary || f.body).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  const v = visibility(saved.isPublished, fromLocalInput(saved.date) ?? post?.publishedAt ?? null)
  const blogOptions = post && !blogs.some((b) => b.handle === post.blogHandle) ? [...blogs, { handle: post.blogHandle, title: post.blogTitle, posts: 1 }] : blogs

  async function onImage(files: File[]) {
    if (!files.length) return
    setUploading(true)
    try {
      const [img] = await uploadImages(files.slice(0, 1), () => uploadUrl({}), (x) => fileUrl(x), f.title)
      if (img) set("image", { url: img.url, altText: f.image?.altText || f.title, width: img.w, height: img.h })
    } catch (e) { toast.error(errMsg(e)) } finally { setUploading(false) }
  }

  async function onSave() {
    if (!f.title.trim()) { toast.error("Add a title"); return }
    if (isNewBlog && !f.newBlog.trim()) { toast.error("Name the new blog"); return }
    setSaving(true)
    try {
      const keepSame = post?.publishedAt && toLocalInput(post.publishedAt) === f.date
      const id = await save({
        id: post?._id, blogHandle: isNewBlog ? "" : f.blogHandle, blogTitle, title: f.title, handle: f.handle, body: f.body,
        summary: f.summary, tags: f.tags, author: f.author, image: f.image, isPublished: f.isPublished,
        publishedAt: keepSame ? post!.publishedAt! : fromLocalInput(f.date),
        seo: { title: f.seoTitle, description: f.seoDesc }, redirectOld: !!post && redirect,
      })
      markSaved(f); setSaved(f)
      toast.success("Saved — live on the website in about a minute")
      if (isNew || isNewBlog) setTimeout(() => navigate({ to: "/website-post", search: { id }, replace: true }), 0)
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }

  return (
    <div className="mx-auto max-w-5xl pb-24">
      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onDiscard={() => setF(saved)} message={isNew ? "Unsaved blog post" : "Unsaved changes"} />
      <PageHeader title={isNew ? "Create blog post" : saved.title || "Untitled post"} back={{ to: "/website-blog", label: "Blog posts" }}
        badges={post ? <Badge tone={v.tone}>{v.label}</Badge> : undefined}
        secondary={post ? <Button size="sm" variant="outline" asChild><a href={`${PREVIEW_URL}/blogs/${post.blogHandle}/${post.handle}`} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> View</a></Button> : undefined}
        more={post ? [{ label: "Delete blog post", destructive: true, icon: <Trash2 className="size-4" />, onClick: () => setConfirm(true) }] : undefined} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <Section>
            <div className="space-y-4">
              <Field label="Title"><Input autoFocus={isNew} value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. How to choose genuine leather shoes" /></Field>
              <Field label="Content"><RichText value={f.body} onChange={(x) => set("body", x)} placeholder="Write the post…" minHeight={360} /></Field>
            </div>
          </Section>
          <Section title="Excerpt" sub="A short summary shown on the blog page and in search results. Leave empty to use the start of the post.">
            <Textarea rows={3} value={f.summary} onChange={(e) => set("summary", e.target.value)} />
          </Section>
          <div>
            <SeoCard site={SITE_URL} path={`blogs/${pathBlog}`} handle={f.handle} onHandle={(x) => set("handle", x)}
              title={f.seoTitle} onTitle={(x) => set("seoTitle", x)} desc={f.seoDesc} onDesc={(x) => set("seoDesc", x)} fallbackTitle={f.title} fallbackDesc={plain} />
            {post && f.handle && <RedirectNotice from={`/blogs/${post.blogHandle}/${saved.handle}`} to={`/blogs/${pathBlog}/${f.handle}`} checked={redirect} onChange={setRedirect} />}
          </div>
        </div>
        <div className="space-y-4">
          <VisibilityCard isPublished={f.isPublished} onPublished={(x) => set("isPublished", x)} date={f.date} onDate={(x) => set("date", x)} dateLabel="Publish date" />
          <Section title="Image">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { onImage(Array.from(e.target.files ?? [])); e.target.value = "" }} />
            {f.image ? (
              <div className="group relative overflow-hidden rounded-lg border">
                <img src={f.image.url} alt={f.image.altText} className="aspect-[4/3] w-full object-cover" />
                <div className="absolute inset-x-0 bottom-0 flex gap-2 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
            <Button size="sm" variant="link" className="mt-1 h-auto px-0 text-tone-blue" onClick={() => setPicker(true)}><FolderOpen className="size-3.5" /> Choose from Files</Button>
            {f.image && <div className="mt-2"><Field label="Alt text"><Input value={f.image.altText} onChange={(e) => set("image", { ...f.image!, altText: e.target.value })} placeholder="What the picture shows" /></Field></div>}
            <FilePickerDialog open={picker} onOpenChange={setPicker} kind="image" title="Choose an image" onPick={(url) => { set("image", { url, altText: f.image?.altText || f.title, width: null, height: null }); setPicker(false) }} />
          </Section>
          <Section title="Organization">
            <div className="space-y-4">
              <Field label="Author"><SuggestInput value={f.author} onChange={(x) => set("author", x)} suggestions={authors} placeholder="e.g. BlackBole" /></Field>
              <Field label="Blog">
                <select value={f.blogHandle} onChange={(e) => set("blogHandle", e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                  {blogOptions.map((b) => <option key={b.handle} value={b.handle}>{b.title}</option>)}
                  <option value={NEW}>Create a new blog…</option>
                </select>
              </Field>
              {isNewBlog && <Field label="New blog name"><Input value={f.newBlog} onChange={(e) => set("newBlog", e.target.value)} placeholder="e.g. Guides" /></Field>}
              <Field label="Tags"><TagInput value={f.tags} onChange={(x) => set("tags", x)} suggestions={tags} /></Field>
            </div>
          </Section>
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
