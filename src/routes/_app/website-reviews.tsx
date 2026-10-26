// Products → Reviews (like Judge.me's "Manage reviews" on Shopify): every product review with its stars, reviewer,
// date, text and photos. Publish or hide each one (hidden ones leave the website at the next rebuild), approve
// reviews written on the website, write the store's reply, and import the old reviews from Judge.me.
import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useAction, useMutation, useQuery } from "convex/react"
import { Download, EyeOff, Eye, MessageSquare, Star, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { ReviewRow } from "@/convex/reviews"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { WebsiteTabs } from "@/components/discount-ui"
import {
  Badge, Card, EmptyState, Field, FilterChoices, FilterPill, IndexSearch, IndexTable, IndexTabs, PageHeader, SITE_URL, useSelection, useSort,
} from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { dateOnly, dateTime, errMsg } from "@/lib/format"

export const Route = createFileRoute("/_app/website-reviews")({
  component: () => <WebsiteGuard><Reviews /></WebsiteGuard>,
})

type View = "all" | "published" | "pending" | "hidden"
type Rating = "5" | "4" | "3" | "2" | "1"
const PAGE = 50
const SOURCE: Record<string, string> = { judgeme: "Judge.me", website: "Website", manual: "Added by staff" }

function Stars({ n, className }: { n: number; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-px", className)} aria-label={`${n} star${n === 1 ? "" : "s"}`} role="img">
      {[1, 2, 3, 4, 5].map((i) => <Star key={i} className={cn("size-3.5", i <= n ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40")} />)}
    </span>
  )
}

const statusBadge = (s: string) =>
  s === "published" ? <Badge tone="success">Published</Badge> : s === "pending" ? <Badge tone="attention" dot>Pending</Badge> : <Badge>Hidden</Badge>

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

function Reviews() {
  const data = useQuery(api.reviews.list)
  const setStatus = useMutation(api.reviews.setStatus)
  const remove = useMutation(api.reviews.remove)
  const importJudgeMe = useAction(api.reviews.importJudgeMe)
  const [view, setView] = useState<View>("all")
  const [q, setQ] = useState("")
  const [rating, setRating] = useState<Rating | null>(null)
  const [withPhotos, setWithPhotos] = useState<"yes" | null>(null)
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<ReviewRow | null>(null)
  const [importing, setImporting] = useState(false)
  const sort = useSort<"date" | "rating" | "product">("date", "desc")
  const rows = data?.reviews

  const counts = useMemo(() => {
    const c = { all: 0, published: 0, pending: 0, hidden: 0 }
    for (const r of rows ?? []) { c.all++; c[r.status as Exclude<View, "all">]++ }
    return c
  }, [rows])
  const avg = useMemo(() => {
    const pub = (rows ?? []).filter((r) => r.status === "published")
    return pub.length ? pub.reduce((s, r) => s + r.rating, 0) / pub.length : 0
  }, [rows])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    const out = (rows ?? []).filter((r) =>
      (view === "all" || r.status === view) &&
      (!rating || r.rating === Number(rating)) &&
      (!withPhotos || r.photos.length > 0) &&
      (!s || r.author.toLowerCase().includes(s) || r.productTitle.toLowerCase().includes(s) || r.handle.includes(s) || r.title.toLowerCase().includes(s) || r.body.toLowerCase().includes(s) || r.email.includes(s)))
    const k = sort.dir === "asc" ? 1 : -1
    return out.sort((a, b) => k * (sort.by === "rating" ? a.rating - b.rating || a.createdAt - b.createdAt : sort.by === "product" ? a.productTitle.localeCompare(b.productTitle) : a.createdAt - b.createdAt))
  }, [rows, q, view, rating, withPhotos, sort.by, sort.dir])
  const pages = Math.max(1, Math.ceil(list.length / PAGE))
  const shown = list.slice(page * PAGE, page * PAGE + PAGE)
  const sel = useSelection(list.map((r) => r._id))
  const reset = () => setPage(0)

  const runImport = async () => {
    setImporting(true)
    try {
      const r = await importJudgeMe({})
      const msg = `Found ${r.found} review${r.found === 1 ? "" : "s"} on ${r.withReviews} product${r.withReviews === 1 ? "" : "s"}: ${r.added} new, ${r.updated} updated.`
      if (r.failed.length) toast.warning(`${msg} ${r.failed.length} product${r.failed.length === 1 ? "" : "s"} could not be read: ${r.failed.slice(0, 3).join("; ")}`)
      else toast.success(msg)
    } catch (e) { toast.error(errMsg(e)) } finally { setImporting(false) }
  }
  const bulkStatus = async (status: "published" | "hidden", ids: string[]) => {
    try {
      const n = await setStatus({ ids: ids as Id<"webReviews">[], status })
      sel.clear()
      toast.success(`${n} review${n === 1 ? "" : "s"} ${status === "published" ? "published" : "hidden"}. The website updates in a few minutes.`)
    } catch (e) { toast.error(errMsg(e)) }
  }
  const download = (which: ReviewRow[]) => {
    const lines = ["product_handle,product,rating,title,body,reviewer,email,location,verified,status,source,date,photos,reply",
      ...which.map((r) => [r.handle, r.productTitle, String(r.rating), r.title, r.body, r.author, r.email, r.location, r.verified ? "yes" : "", r.status, r.source, new Date(r.createdAt).toISOString(), r.photos.join(" "), r.reply].map(csvCell).join(","))]
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }))
    const a = document.createElement("a")
    a.href = url; a.download = `blackbole-reviews-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  const importBtn = <Button size="sm" variant={rows?.length ? "outline" : "default"} disabled={importing} onClick={runImport}>{importing ? "Importing… (a minute or two)" : "Import from Judge.me"}</Button>

  return (
    <div className="mx-auto max-w-6xl">
      <WebsiteTabs active="products" />
      <PageHeader title="Reviews"
        subtitle={rows && rows.length ? `${counts.published} published${avg ? ` · ${avg.toFixed(2)} average` : ""}${data?.lastImport ? ` · last Judge.me import ${dateTime(data.lastImport.at)}` : ""}` : "Product reviews shown on the website."}
        secondary={<Button size="sm" variant="outline" disabled={!list.length} onClick={() => download(list)}><Download className="size-4" /> Export</Button>}
        primary={importBtn} />

      {data === undefined ? <Loading /> : data === null ? null : !rows || rows.length === 0 ? (
        <Card><EmptyState icon={<MessageSquare />} title="No reviews yet"
          text="Bring in the reviews customers wrote on the old Shopify store (Judge.me). New reviews written on the website appear here too, waiting for your approval."
          primary={importBtn} /></Card>
      ) : (
        <Card flush>
          <IndexTabs<View> value={view} onChange={(v) => { setView(v); reset() }} tabs={[
            { id: "all", label: "All", count: counts.all },
            { id: "published", label: "Published", count: counts.published },
            { id: "pending", label: "Pending", count: counts.pending },
            { id: "hidden", label: "Hidden", count: counts.hidden },
          ]} />
          <IndexSearch value={q} onChange={(v) => { setQ(v); reset() }} placeholder="Search by product, reviewer or text" pills={<>
            <FilterPill label="Rating" value={rating ? `${rating} star${rating === "1" ? "" : "s"}` : undefined} onClear={() => { setRating(null); reset() }}>
              <FilterChoices<Rating> options={(["5", "4", "3", "2", "1"] as Rating[]).map((r) => ({ value: r, label: <Stars n={Number(r)} /> }))} value={rating} onChange={(v) => { setRating(v); reset() }} />
            </FilterPill>
            <FilterPill label="Photos" value={withPhotos ? "With photos" : undefined} onClear={() => { setWithPhotos(null); reset() }}>
              <FilterChoices<"yes"> options={[{ value: "yes", label: "With photos" }]} value={withPhotos} onChange={(v) => { setWithPhotos(v); reset() }} />
            </FilterPill>
          </>} />
          <IndexTable<ReviewRow>
            rows={shown} rowId={(r) => r._id} sel={sel} total={list.length}
            sort={sort} onSort={(k) => sort.toggle(k as "date" | "rating" | "product")}
            onRowClick={(r) => setOpen(r)}
            bulk={<>
              <Button size="sm" variant="outline" onClick={() => bulkStatus("published", [...sel.selected])}><Eye className="size-4" /> Publish</Button>
              <Button size="sm" variant="outline" onClick={() => bulkStatus("hidden", [...sel.selected])}><EyeOff className="size-4" /> Hide</Button>
            </>}
            bulkMore={[
              { label: "Export", icon: <Download className="size-4" />, onClick: () => download(list.filter((r) => sel.has(r._id))) },
              { label: "Delete reviews", destructive: true, icon: <Trash2 className="size-4" />, onClick: async () => {
                if (!window.confirm(`Delete ${sel.count} review${sel.count === 1 ? "" : "s"} for good? Hiding keeps them, deleting can't be undone.`)) return
                try { const n = await remove({ ids: [...sel.selected] as Id<"webReviews">[] }); sel.clear(); toast.success(`${n} deleted`) } catch (e) { toast.error(errMsg(e)) }
              } },
            ]}
            empty={<p className="px-4 py-10 text-center text-sm text-muted-foreground">No reviews match.</p>}
            columns={[
              { key: "review", label: "Review", render: (r) => (
                <div className="min-w-[220px] max-w-[460px] py-0.5">
                  <div className="flex items-center gap-2"><Stars n={r.rating} />{r.title && <span className="truncate font-semibold">{r.title}</span>}</div>
                  <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-[13px] text-muted-foreground">{r.body}</p>
                  {r.photos.length > 0 && (
                    <div className="mt-1.5 flex gap-1">
                      {r.photos.slice(0, 4).map((u) => <img key={u} src={u} alt="" loading="lazy" className="size-10 rounded-md border object-cover" />)}
                      {r.photos.length > 4 && <span className="flex size-10 items-center justify-center rounded-md border text-xs text-muted-foreground">+{r.photos.length - 4}</span>}
                    </div>
                  )}
                  {r.reply && <p className="mt-1 line-clamp-1 text-xs text-muted-foreground"><MessageSquare className="mr-1 inline size-3" />Replied</p>}
                </div>
              ) },
              { key: "product", label: "Product", sortable: true, hideBelow: "md", render: (r) => <span className="line-clamp-2 max-w-[220px]">{r.productTitle}</span> },
              { key: "reviewer", label: "Reviewer", hideBelow: "sm", render: (r) => (
                <div className="max-w-[160px]">
                  <div className="truncate font-medium">{r.author}</div>
                  <div className="text-xs text-muted-foreground">{r.verified ? "Verified buyer · " : ""}{SOURCE[r.source] ?? r.source}</div>
                </div>
              ) },
              { key: "rating", label: "Rating", sortable: true, hideBelow: "lg", render: (r) => <span className="tabular-nums">{r.rating}</span> },
              { key: "date", label: "Date", sortable: true, hideBelow: "lg", render: (r) => <span className="whitespace-nowrap text-muted-foreground">{dateOnly(r.createdAt)}</span> },
              { key: "status", label: "On website", align: "right", render: (r) => (
                <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                  {r.status === "pending" && <Badge tone="attention" dot>Pending</Badge>}
                  <Switch checked={r.status === "published"} aria-label={r.status === "published" ? "Hide this review" : "Publish this review"}
                    onCheckedChange={(on) => bulkStatus(on ? "published" : "hidden", [r._id])} />
                </div>
              ) },
            ]}
          />
          {pages > 1 && (
            <div className="flex items-center justify-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span className="tabular-nums">Page {page + 1} of {pages}</span>
              <Button size="sm" variant="outline" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          )}
        </Card>
      )}
      <ReviewDialog review={open && rows ? rows.find((r) => r._id === open._id) ?? null : null} onClose={() => setOpen(null)} onStatus={(s, id) => bulkStatus(s, [id])} />
    </div>
  )
}

function ReviewDialog({ review, onClose, onStatus }: { review: ReviewRow | null; onClose: () => void; onStatus: (s: "published" | "hidden", id: string) => void }) {
  const setReply = useMutation(api.reviews.setReply)
  const [reply, setReplyText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const r = review
  const text = reply ?? r?.reply ?? ""
  return (
    <Dialog open={!!r} onOpenChange={(o) => { if (!o) { onClose(); setReplyText(null) } }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {r && <>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Stars n={r.rating} /> {r.title || "Review"}</DialogTitle>
            <DialogDescription>
              {r.author}{r.location ? `, ${r.location}` : ""}{r.verified ? " · Verified buyer" : ""} · {dateTime(r.createdAt)} · {SOURCE[r.source] ?? r.source}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {statusBadge(r.status)}
              <a href={`${SITE_URL}/products/${r.handle}`} target="_blank" rel="noreferrer" className="text-tone-blue hover:underline">{r.productTitle}</a>
            </div>
            <p className="whitespace-pre-line">{r.body}</p>
            {r.email && <p className="text-xs text-muted-foreground">Email (not shown on the website): <a className="hover:underline" href={`mailto:${r.email}`}>{r.email}</a></p>}
            {r.photos.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {r.photos.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="Customer photo" className="aspect-square w-full rounded-lg border object-cover" /></a>)}
              </div>
            )}
            <Field label="Store reply" hint="Shown under the review on the website.">
              <Textarea rows={3} value={text} onChange={(e) => setReplyText(e.target.value)} placeholder="Thank you for your review!" />
            </Field>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={() => onStatus(r.status === "published" ? "hidden" : "published", r._id)}>
              {r.status === "published" ? <><EyeOff className="size-4" /> Hide</> : <><Eye className="size-4" /> Publish</>}
            </Button>
            <Button disabled={busy || text.trim() === r.reply.trim()} onClick={async () => {
              setBusy(true)
              try { await setReply({ id: r._id, reply: text }); toast.success(text.trim() ? "Reply saved" : "Reply removed"); setReplyText(null) } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
            }}>Save reply</Button>
          </DialogFooter>
        </>}
      </DialogContent>
    </Dialog>
  )
}
