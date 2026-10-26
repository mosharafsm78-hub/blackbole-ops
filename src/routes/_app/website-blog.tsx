import { useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { ImageOff, Newspaper, Plus, Search } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { EmptyImport, WebsiteHeader } from "@/components/content-ui"
import { StatusBadge } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/website-blog")({
  component: () => <WebsiteGuard><BlogList /></WebsiteGuard>,
})

const date = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Not published")

function BlogList() {
  const data = useQuery(api.content.posts)
  const navigate = useNavigate()
  const [q, setQ] = useState("")
  const [blog, setBlog] = useState("")
  const s = q.trim().toLowerCase()
  const list = (data?.posts ?? []).filter((p) => (!blog || p.blogHandle === blog) && (!s || p.title.toLowerCase().includes(s) || p.author.toLowerCase().includes(s)))
  return (
    <div className="mx-auto max-w-6xl">
      <WebsiteHeader active="blog" sub="Blog posts: guides, news and stories that bring visitors from Google.">
        <Button size="sm" asChild><Link to="/website-post" search={{ id: "" }}><Plus className="size-4" /> Write post</Link></Button>
      </WebsiteHeader>
      {data === undefined ? <Loading /> : data === null ? null : data.posts.length === 0 ? (
        <EmptyImport icon={<Newspaper className="size-5" />} what="posts" title="No blog posts in Ops yet"
          text="The website still shows the posts copied from Shopify. Copy them here once to edit them, or write a new post." />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
            <div className="relative min-w-52 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search posts" className="h-8 border-0 bg-transparent pl-8 shadow-none focus-visible:ring-0" />
            </div>
            <div className="flex flex-wrap gap-1">
              {[{ handle: "", title: "All blogs" }, ...data.blogs].map((b) => (
                <button key={b.handle} type="button" onClick={() => setBlog(b.handle)}
                  className={cn("rounded-md px-2.5 py-1 text-[13px] font-medium", blog === b.handle ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")}>{b.title}</button>
              ))}
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b"><th className="py-2 pl-4 pr-3 font-medium">Post</th><th className="hidden py-2 pr-3 font-medium md:table-cell">Blog</th><th className="py-2 pr-3 font-medium">Status</th><th className="hidden py-2 pr-4 text-right font-medium sm:table-cell">Date</th></tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p._id} onClick={() => navigate({ to: "/website-post", search: { id: p._id } })} className="group cursor-pointer border-b last:border-0 hover:bg-muted/40">
                  <td className="py-2.5 pl-4 pr-3">
                    <div className="flex items-center gap-3">
                      {p.image ? <img src={p.image} alt="" loading="lazy" className="size-10 shrink-0 rounded-md border object-cover" /> : <div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"><ImageOff className="size-4" /></div>}
                      <div className="min-w-0"><div className="line-clamp-1 font-medium group-hover:underline">{p.title}</div><div className="text-xs text-muted-foreground">{p.author || "No author"}</div></div>
                    </div>
                  </td>
                  <td className="hidden py-2.5 pr-3 text-muted-foreground md:table-cell">{p.blogTitle}</td>
                  <td className="py-2.5 pr-3"><StatusBadge on={p.isPublished} label={p.isPublished ? "Visible" : "Hidden"} /></td>
                  <td className="hidden py-2.5 pr-4 text-right text-muted-foreground sm:table-cell">{date(p.publishedAt)}</td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">No post matches.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
