// Website → Blog posts (Shopify: Content → Blog posts): Title, Blog, Author, Visibility, Date; filter by blog,
// tick rows for bulk actions, and Manage blogs (create, rename, change address, delete empty blogs).
import { useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Eye, EyeOff, ImageOff, Newspaper, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { EmptyImport, ImportButton } from "@/components/content-ui"
import { shortDate, visibility } from "@/components/content-editor"
import { WebsiteTabs } from "@/components/discount-ui"
import { Badge, Card, Field, FilterChoices, FilterPill, IndexSearch, IndexTable, IndexTabs, PageHeader, useSelection, useSort } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { errMsg } from "@/lib/format"

export const Route = createFileRoute("/_app/website-blog")({
  component: () => <WebsiteGuard><BlogList /></WebsiteGuard>,
})

type View = "all" | "visible" | "hidden"
type Row = { _id: Id<"webPosts">; blogHandle: string; blogTitle: string; handle: string; title: string; isPublished: boolean; publishedAt: string | null; author: string; image: string | null; tags: string[]; updatedAt: number }
type Blog = { handle: string; title: string; posts: number }

function BlogList() {
  const data = useQuery(api.content.posts)
  const bulk = useMutation(api.content.bulkPosts)
  const navigate = useNavigate()
  const [q, setQ] = useState("")
  const [view, setView] = useState<View>("all")
  const [blog, setBlog] = useState<string | null>(null)
  const [author, setAuthor] = useState<string | null>(null)
  const [manage, setManage] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const sort = useSort<"title" | "date">("date", "desc")
  const s = q.trim().toLowerCase()
  const posts = (data?.posts ?? []) as Row[]
  const blogs = (data?.blogs ?? []) as Blog[]
  const authors = useMemo(() => [...new Set(posts.map((p) => p.author).filter(Boolean))].sort(), [posts])
  const list = useMemo(() => {
    const out = posts.filter((p) => (view === "all" || (view === "visible") === p.isPublished)
      && (!blog || p.blogHandle === blog) && (!author || p.author === author)
      && (!s || p.title.toLowerCase().includes(s) || p.author.toLowerCase().includes(s) || p.tags.some((t) => t.toLowerCase().includes(s))))
    const k = sort.dir === "asc" ? 1 : -1
    return out.sort((a, b) => k * (sort.by === "title" ? a.title.localeCompare(b.title) : String(a.publishedAt ?? "").localeCompare(String(b.publishedAt ?? ""))))
  }, [posts, view, blog, author, s, sort.by, sort.dir])
  const sel = useSelection(list.map((p) => p._id))
  const ids = [...sel.selected] as Id<"webPosts">[]

  async function run(action: "show" | "hide" | "delete") {
    try {
      const n = await bulk({ ids, action })
      toast.success(`${n} post${n === 1 ? "" : "s"} ${action === "delete" ? "deleted" : action === "show" ? "made visible" : "hidden"}`)
      sel.clear()
    } catch (e) { toast.error(errMsg(e)) }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <WebsiteTabs active="blog" />
      <PageHeader title="Blog posts" subtitle="Guides, news and stories that bring visitors from Google."
        secondary={<>
          {posts.length > 0 && <ImportButton what="posts" label="Copy from website" />}
          <Button size="sm" variant="outline" onClick={() => setManage(true)}>Manage blogs</Button>
        </>}
        primary={<Button size="sm" asChild><Link to="/website-post" search={{ id: "", blog: blog ?? undefined }}>Create blog post</Link></Button>} />
      {data === undefined ? <Loading /> : data === null ? null : posts.length === 0 ? (
        <EmptyImport icon={<Newspaper className="size-5" />} what="posts" title="No blog posts in Ops yet"
          text="The website still shows the posts copied from Shopify. Copy them here once to edit them, or write a new post." />
      ) : (
        <Card flush>
          <IndexTabs<View> value={view} onChange={setView} tabs={[
            { id: "all", label: "All" },
            { id: "visible", label: "Visible", count: posts.filter((p) => p.isPublished).length },
            { id: "hidden", label: "Hidden", count: posts.filter((p) => !p.isPublished).length },
          ]} />
          <IndexSearch value={q} onChange={setQ} placeholder="Search blog posts" pills={<>
            <FilterPill label="Blog" value={blog ? blogs.find((b) => b.handle === blog)?.title ?? blog : undefined} onClear={() => setBlog(null)}>
              <FilterChoices options={blogs.map((b) => ({ value: b.handle, label: `${b.title} (${b.posts})` }))} value={blog} onChange={setBlog} />
            </FilterPill>
            {authors.length > 1 && (
              <FilterPill label="Author" value={author ?? undefined} onClear={() => setAuthor(null)}>
                <FilterChoices options={authors.map((a) => ({ value: a, label: a }))} value={author} onChange={setAuthor} />
              </FilterPill>
            )}
          </>} />
          <IndexTable<Row>
            rows={list} rowId={(p) => p._id} sel={sel} total={list.length}
            sort={sort} onSort={(k) => sort.toggle(k as "title" | "date")}
            onRowClick={(p) => navigate({ to: "/website-post", search: { id: p._id } })}
            bulk={<>
              <Button size="sm" variant="outline" onClick={() => run("show")}><Eye className="size-4" /> Make visible</Button>
              <Button size="sm" variant="outline" onClick={() => run("hide")}><EyeOff className="size-4" /> Hide</Button>
            </>}
            bulkMore={[{ label: "Delete blog posts", destructive: true, icon: <Trash2 className="size-4" />, onClick: () => setConfirm(true) }]}
            empty={<p className="px-4 py-10 text-center text-sm text-muted-foreground">No blog post matches.</p>}
            columns={[
              { key: "title", label: "Title", sortable: true, render: (p) => (
                <div className="flex items-center gap-3">
                  {p.image ? <img src={p.image} alt="" loading="lazy" className="size-10 shrink-0 rounded-md border object-cover" /> : <div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"><ImageOff className="size-4" /></div>}
                  <div className="min-w-0 font-semibold group-hover:underline"><span className="line-clamp-2">{p.title}</span></div>
                </div>
              ) },
              { key: "blog", label: "Blog", hideBelow: "md", render: (p) => <span className="text-muted-foreground">{p.blogTitle}</span> },
              { key: "author", label: "Author", hideBelow: "lg", render: (p) => <span className="text-muted-foreground">{p.author || "—"}</span> },
              { key: "visibility", label: "Visibility", render: (p) => { const v = visibility(p.isPublished, p.publishedAt); return <Badge tone={v.tone}>{v.label}</Badge> } },
              { key: "date", label: "Date", sortable: true, align: "right", hideBelow: "sm", render: (p) => <span className="text-muted-foreground">{p.publishedAt ? shortDate(p.publishedAt) : "—"}</span> },
            ]}
          />
        </Card>
      )}

      <ManageBlogs open={manage} onOpenChange={setManage} blogs={blogs} />

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {ids.length} blog post{ids.length === 1 ? "" : "s"}?</DialogTitle>
            <DialogDescription>They disappear from the website. This can't be undone. To keep a post but take it off the website, hide it instead.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={async () => { setConfirm(false); await run("delete") }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ManageBlogs({ open, onOpenChange, blogs }: { open: boolean; onOpenChange: (v: boolean) => void; blogs: Blog[] }) {
  const save = useMutation(api.content.saveBlog)
  const del = useMutation(api.content.deleteBlog)
  const [edit, setEdit] = useState<{ handle?: string; title: string; newHandle: string; redirect: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setEdit(null) }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{edit ? (edit.handle ? "Edit blog" : "Add blog") : "Manage blogs"}</DialogTitle>
          <DialogDescription>{edit ? "Every post in the blog moves with it." : "Group posts into blogs, like News or Guides. Each blog has its own page on the website."}</DialogDescription>
        </DialogHeader>
        {edit ? (
          <div className="space-y-3">
            <Field label="Name"><Input autoFocus value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="e.g. News" /></Field>
            <Field label="Web address" hint={edit.handle ? undefined : "Leave empty to make it from the name."}>
              <div className="flex items-center overflow-hidden rounded-md border bg-muted/40 text-sm">
                <span className="pl-3 text-muted-foreground">/blogs/</span>
                <input value={edit.newHandle} onChange={(e) => setEdit({ ...edit, newHandle: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-") })} className="h-9 min-w-0 flex-1 bg-background px-2 outline-none" />
              </div>
            </Field>
            {edit.handle && edit.newHandle && edit.newHandle !== edit.handle && (
              <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-0.5 accent-foreground" checked={edit.redirect} onChange={(e) => setEdit({ ...edit, redirect: e.target.checked })} />
                Create URL redirects from /blogs/{edit.handle} (and its posts) to the new address</label>
            )}
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {blogs.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">No blogs yet.</p>}
            {blogs.map((b) => (
              <div key={b.handle} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1"><div className="text-sm font-medium">{b.title}</div><div className="text-xs text-muted-foreground">/blogs/{b.handle} · {b.posts} post{b.posts === 1 ? "" : "s"}</div></div>
                <Button size="icon-sm" variant="ghost" aria-label="Edit blog" onClick={() => setEdit({ handle: b.handle, title: b.title, newHandle: b.handle, redirect: true })}><Pencil className="size-3.5" /></Button>
                <Button size="icon-sm" variant="ghost" aria-label="Delete blog" disabled={b.posts > 0} title={b.posts ? "Move or delete its posts first" : "Delete"} onClick={async () => {
                  try { await del({ handle: b.handle }); toast.success("Blog deleted") } catch (e) { toast.error(errMsg(e)) }
                }}><Trash2 className="size-3.5" /></Button>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          {edit ? <>
            <Button variant="outline" onClick={() => setEdit(null)}>Back</Button>
            <Button disabled={busy || !edit.title.trim()} onClick={async () => {
              setBusy(true)
              try {
                await save({ handle: edit.handle, title: edit.title, newHandle: edit.newHandle || undefined, redirectOld: edit.redirect })
                toast.success("Blog saved"); setEdit(null)
              } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
            }}>Save</Button>
          </> : <Button variant="outline" onClick={() => setEdit({ title: "", newHandle: "", redirect: false })}><Plus className="size-4" /> Add blog</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
