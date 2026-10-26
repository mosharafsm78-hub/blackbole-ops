// Website → Pages (Shopify: Online Store → Pages): list with Title, Visibility, Updated; tick rows for bulk actions.
import { useMemo, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Eye, EyeOff, FileText, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { EmptyImport, ImportButton, ago } from "@/components/content-ui"
import { WebsiteTabs } from "@/components/discount-ui"
import { PAGE_TEMPLATES, visibility } from "@/components/content-editor"
import { Badge, Card, FilterChoices, FilterPill, IndexSearch, IndexTable, IndexTabs, PageHeader, useSelection, useSort } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { errMsg } from "@/lib/format"

export const Route = createFileRoute("/_app/website-pages")({
  component: () => <WebsiteGuard><PagesList /></WebsiteGuard>,
})

type View = "all" | "visible" | "hidden"
type Row = { _id: Id<"webPages">; handle: string; title: string; isPublished: boolean; publishedAt: string | null; templateSuffix: string | null; updatedAt: number; words: number }

function PagesList() {
  const rows = useQuery(api.content.pages) as Row[] | null | undefined
  const bulk = useMutation(api.content.bulkPages)
  const navigate = useNavigate()
  const [q, setQ] = useState("")
  const [view, setView] = useState<View>("all")
  const [tpl, setTpl] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const sort = useSort<"title" | "updated">("title", "asc")
  const s = q.trim().toLowerCase()
  const all = rows ?? []
  const list = useMemo(() => {
    const out = all.filter((p) => (view === "all" || (view === "visible") === p.isPublished)
      && (tpl === null || (p.templateSuffix ?? "") === tpl)
      && (!s || p.title.toLowerCase().includes(s) || p.handle.includes(s)))
    const k = sort.dir === "asc" ? 1 : -1
    return out.sort((a, b) => k * (sort.by === "title" ? a.title.localeCompare(b.title) : a.updatedAt - b.updatedAt))
  }, [all, view, tpl, s, sort.by, sort.dir]) // eslint-disable-line react-hooks/exhaustive-deps
  const sel = useSelection(list.map((p) => p._id))
  const ids = [...sel.selected] as Id<"webPages">[]

  async function run(action: "show" | "hide" | "delete") {
    try {
      const n = await bulk({ ids, action })
      toast.success(`${n} page${n === 1 ? "" : "s"} ${action === "delete" ? "deleted" : action === "show" ? "made visible" : "hidden"}`)
      sel.clear()
    } catch (e) { toast.error(errMsg(e)) }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <WebsiteTabs active="pages" />
      <PageHeader title="Pages" subtitle="About us, contact, policies and other text pages on the website."
        secondary={rows && rows.length > 0 ? <ImportButton what="pages" label="Copy from website" /> : undefined}
        primary={<Button size="sm" asChild><Link to="/website-page" search={{ id: "" }}>Add page</Link></Button>} />
      {rows === undefined ? <Loading /> : rows === null ? null : rows.length === 0 ? (
        <EmptyImport icon={<FileText className="size-5" />} what="pages" title="No pages in Ops yet"
          text="The website still shows the pages copied from Shopify. Copy them here once to edit them, or add a new page." />
      ) : (
        <Card flush>
          <IndexTabs<View> value={view} onChange={setView} tabs={[
            { id: "all", label: "All" },
            { id: "visible", label: "Visible", count: all.filter((p) => p.isPublished).length },
            { id: "hidden", label: "Hidden", count: all.filter((p) => !p.isPublished).length },
          ]} />
          <IndexSearch value={q} onChange={setQ} placeholder="Search pages" pills={
            <FilterPill label="Template" value={tpl === null ? undefined : PAGE_TEMPLATES[tpl] ?? tpl} onClear={() => setTpl(null)}>
              <FilterChoices options={Object.entries(PAGE_TEMPLATES).map(([value, label]) => ({ value, label }))} value={tpl} onChange={setTpl} />
            </FilterPill>
          } />
          <IndexTable<Row>
            rows={list} rowId={(p) => p._id} sel={sel} total={list.length}
            sort={sort} onSort={(k) => sort.toggle(k as "title" | "updated")}
            onRowClick={(p) => navigate({ to: "/website-page", search: { id: p._id } })}
            bulk={<>
              <Button size="sm" variant="outline" onClick={() => run("show")}><Eye className="size-4" /> Make visible</Button>
              <Button size="sm" variant="outline" onClick={() => run("hide")}><EyeOff className="size-4" /> Hide</Button>
            </>}
            bulkMore={[{ label: "Delete pages", destructive: true, icon: <Trash2 className="size-4" />, onClick: () => setConfirm(true) }]}
            empty={<p className="px-4 py-10 text-center text-sm text-muted-foreground">No page matches.</p>}
            columns={[
              { key: "title", label: "Title", sortable: true, render: (p) => (
                <div className="min-w-0">
                  <div className="font-semibold group-hover:underline">{p.title}</div>
                  <div className="text-xs text-muted-foreground">/pages/{p.handle}{p.templateSuffix ? ` · ${PAGE_TEMPLATES[p.templateSuffix] ?? p.templateSuffix}` : ""}{p.words ? ` · ${p.words} words` : ""}</div>
                </div>
              ) },
              { key: "visibility", label: "Visibility", render: (p) => { const v = visibility(p.isPublished, p.publishedAt); return <Badge tone={v.tone}>{v.label}</Badge> } },
              { key: "updated", label: "Updated", sortable: true, align: "right", hideBelow: "sm", render: (p) => <span className="text-muted-foreground">{ago(p.updatedAt)}</span> },
            ]}
          />
        </Card>
      )}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {ids.length} page{ids.length === 1 ? "" : "s"}?</DialogTitle>
            <DialogDescription>They disappear from the website and menu links to them stop working. This can't be undone. To keep a page but take it off the website, hide it instead.</DialogDescription>
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
