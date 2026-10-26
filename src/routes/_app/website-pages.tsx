import { useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "convex/react"
import { FileText, Plus, Search } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { EmptyImport, WebsiteHeader, ago } from "@/components/content-ui"
import { StatusBadge } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export const Route = createFileRoute("/_app/website-pages")({
  component: () => <WebsiteGuard><PagesList /></WebsiteGuard>,
})

const LAYOUT: Record<string, string> = { contact: "Contact form", "custom-shoes": "Design your own pair" }

function PagesList() {
  const rows = useQuery(api.content.pages)
  const navigate = useNavigate()
  const [q, setQ] = useState("")
  const s = q.trim().toLowerCase()
  const list = (rows ?? []).filter((p) => !s || p.title.toLowerCase().includes(s) || p.handle.includes(s))
  return (
    <div className="mx-auto max-w-6xl">
      <WebsiteHeader active="pages" sub="About us, contact, policies and other text pages on the website.">
        <Button size="sm" asChild><Link to="/website-page" search={{ id: "" }}><Plus className="size-4" /> Add page</Link></Button>
      </WebsiteHeader>
      {rows === undefined ? <Loading /> : rows === null ? null : rows.length === 0 ? (
        <EmptyImport icon={<FileText className="size-5" />} what="pages" title="No pages in Ops yet"
          text="The website still shows the pages copied from Shopify. Copy them here once to edit them, or add a new page." />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b px-3 py-2">
            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages" className="h-8 border-0 bg-transparent pl-8 shadow-none focus-visible:ring-0" />
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b"><th className="py-2 pl-4 pr-3 font-medium">Page</th><th className="py-2 pr-3 font-medium">Status</th><th className="hidden py-2 pr-4 text-right font-medium sm:table-cell">Updated</th></tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p._id} onClick={() => navigate({ to: "/website-page", search: { id: p._id } })} className="group cursor-pointer border-b last:border-0 hover:bg-muted/40">
                  <td className="py-2.5 pl-4 pr-3">
                    <div className="font-medium group-hover:underline">{p.title}</div>
                    <div className="text-xs text-muted-foreground">/pages/{p.handle}{p.templateSuffix && LAYOUT[p.templateSuffix] ? ` · ${LAYOUT[p.templateSuffix]}` : ""}{p.words ? ` · ${p.words} words` : ""}</div>
                  </td>
                  <td className="py-2.5 pr-3"><StatusBadge on={p.isPublished} label={p.isPublished ? "Visible" : "Hidden"} /></td>
                  <td className="hidden py-2.5 pr-4 text-right text-muted-foreground sm:table-cell">{ago(p.updatedAt)}</td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={3} className="px-4 py-10 text-center text-sm text-muted-foreground">No page matches.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
