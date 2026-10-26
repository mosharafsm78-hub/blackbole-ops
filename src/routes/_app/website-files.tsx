// Website → Files (Shopify: Content → Files): pictures and videos for the website. Grid or list view, drag-and-drop
// upload, search, sort, file type filter, copy link, alt text, delete, size and dimensions. "Import the website's
// current pictures" adds the theme pictures the website already serves (by link, nothing is re-uploaded).
import { useMemo, useRef, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useAction, useMutation, useQuery } from "convex/react"
import { Copy, Download, Film, LayoutGrid, List, Loader2, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { ago } from "@/components/content-ui"
import { WebsiteTabs } from "@/components/discount-ui"
import { ACCEPT, Thumb, formatBytes, useUploadFiles } from "@/components/file-picker"
import { Card, EmptyState, FilterChoices, FilterPill, IndexSearch, IndexTable, PageHeader, RowCheckbox, useSelection } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/website-files")({
  component: () => <WebsiteGuard><Files /></WebsiteGuard>,
})

type Kind = "all" | "image" | "video"
type SortKey = "newest" | "oldest" | "name-asc" | "name-desc" | "size-desc" | "size-asc"
type F = { _id: string; url: string; name: string; type: string; size: number; w: number | null; h: number | null; alt: string; createdAt: number }
const SORTS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Date added (newest first)" }, { value: "oldest", label: "Date added (oldest first)" },
  { value: "name-asc", label: "File name A–Z" }, { value: "name-desc", label: "File name Z–A" },
  { value: "size-desc", label: "File size (largest first)" }, { value: "size-asc", label: "File size (smallest first)" },
]
const ext = (f: F) => (f.name.split(".").pop() ?? f.type.split("/")[1] ?? "").toUpperCase()
const dims = (f: F) => (f.w && f.h ? `${f.w} × ${f.h}` : "")
const copy = (url: string) => { navigator.clipboard.writeText(url); toast.success("Link copied") }
const VIEW_KEY = "bb.files.view"

function Files() {
  const [q, setQ] = useState("")
  const [kind, setKind] = useState<Kind>("all")
  const [sort, setSort] = useState<SortKey>("newest")
  const [view, setViewState] = useState<"grid" | "list">(() => { try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid" } catch { return "grid" } })
  const setView = (v: "grid" | "list") => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v) } catch { /* private mode */ } }
  const raw = useQuery(api.files.list, { q, kind }) as F[] | null | undefined
  const { upload, busy } = useUploadFiles()
  const remove = useMutation(api.files.remove)
  const importSite = useAction(api.files.importSiteFiles)
  const [importing, setImporting] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const files = useMemo(() => {
    if (!raw) return raw
    const out = [...raw]
    const by: Record<SortKey, (a: F, b: F) => number> = {
      newest: (a, b) => b.createdAt - a.createdAt, oldest: (a, b) => a.createdAt - b.createdAt,
      "name-asc": (a, b) => a.name.localeCompare(b.name), "name-desc": (a, b) => b.name.localeCompare(a.name),
      "size-desc": (a, b) => b.size - a.size, "size-asc": (a, b) => a.size - b.size,
    }
    return out.sort(by[sort])
  }, [raw, sort])
  const sel = useSelection((files ?? []).map((f) => f._id))
  const current = files?.find((f) => f._id === open) ?? null

  const doUpload = async (list: File[]) => {
    if (!list.length) return
    const urls = await upload(list)
    if (urls.length) toast.success(urls.length === 1 ? "Uploaded" : `${urls.length} files uploaded`)
  }
  const deleteSelected = async () => {
    if (!confirm(`Delete ${sel.count} file${sel.count > 1 ? "s" : ""}? Pictures a theme still uses go back to the website's built-in ones.`)) return
    try { await remove({ ids: [...sel.selected] as Id<"webFiles">[] }); sel.clear(); toast.success("Deleted") } catch (e) { toast.error(errMsg(e)) }
  }
  const runImport = async () => {
    setImporting(true)
    try {
      const r = await importSite({})
      toast.success(r.added ? `Added ${r.added} picture${r.added === 1 ? "" : "s"} and video${r.added === 1 ? "" : "s"} from the website` : `All ${r.found} of the website's pictures are already in Files`)
    } catch (e) { toast.error(errMsg(e)) } finally { setImporting(false) }
  }
  const filtered = !!q || kind !== "all"

  return (
    <div className="mx-auto max-w-6xl"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrag(true) } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false) }}
      onDrop={(e) => { if (!e.dataTransfer.types.includes("Files")) return; e.preventDefault(); setDrag(false); doUpload(Array.from(e.dataTransfer.files)) }}>
      <WebsiteTabs active="files" />
      <PageHeader title="Files" subtitle="Pictures and videos for the website: banners, category tiles, theme pictures."
        secondary={<Button size="sm" variant="outline" disabled={importing} onClick={runImport}>{importing ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Import the website's current pictures</Button>}
        primary={<Button size="sm" onClick={() => input.current?.click()} disabled={busy > 0}>
          {busy > 0 ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} {busy > 0 ? `Uploading ${busy}…` : "Upload files"}
        </Button>} />
      <input ref={input} type="file" hidden multiple accept={ACCEPT.all} onChange={(e) => { doUpload(Array.from(e.target.files ?? [])); e.target.value = "" }} />

      <Card flush className={cn(drag && "ring-2 ring-tone-blue")}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <IndexSearch value={q} onChange={setQ} placeholder="Search files by name or alt text" pills={<>
              <FilterPill label="File type" value={kind === "all" ? undefined : kind === "image" ? "Images" : "Videos"} onClear={() => setKind("all")}>
                <FilterChoices<Kind> options={[{ value: "image", label: "Images" }, { value: "video", label: "Videos" }]} value={kind === "all" ? null : kind} onChange={(v) => setKind(v ?? "all")} />
              </FilterPill>
              <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">Sort
                <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="h-7 rounded-lg border bg-background px-1.5 text-xs text-foreground">
                  {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
            </>} />
          </div>
          <div className="flex shrink-0 rounded-lg border p-0.5 m-1.5">
            <button type="button" aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")} className={cn("rounded-md p-1.5", view === "grid" ? "bg-muted text-foreground" : "text-muted-foreground")}><LayoutGrid className="size-4" /></button>
            <button type="button" aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")} className={cn("rounded-md p-1.5", view === "list" ? "bg-muted text-foreground" : "text-muted-foreground")}><List className="size-4" /></button>
          </div>
        </div>

        {files === undefined ? <Loading /> : files === null ? null : files.length === 0 ? (
          filtered ? <p className="px-4 py-12 text-center text-sm text-muted-foreground">No file matches.</p> : (
            <EmptyState icon={<Upload />} title="Upload and manage your files"
              text="Drop pictures or videos here, or click Upload files. JPG, PNG, WebP, GIF, AVIF, SVG, MP4, WebM or MOV, up to 50 MB each."
              primary={<Button size="sm" onClick={() => input.current?.click()}>Upload files</Button>}
              secondary={<Button size="sm" variant="outline" disabled={importing} onClick={runImport}>Import the website's current pictures</Button>} />
          )
        ) : view === "grid" ? (
          <>
            {sel.count > 0 && (
              <div className="flex items-center gap-3 border-b px-4 py-2 text-[13px]">
                <span className="font-semibold">{sel.count} selected</span>
                <button type="button" className="text-tone-blue hover:underline" onClick={sel.all ? sel.clear : sel.toggleAll}>{sel.all ? "Clear" : `Select all ${files.length}`}</button>
                <Button size="sm" variant="outline" className="ml-auto text-tone-red" onClick={deleteSelected}><Trash2 className="size-4" /> Delete</Button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {files.map((f) => (
                <div key={f._id} className={cn("group relative overflow-hidden rounded-lg border bg-background", sel.has(f._id) && "ring-2 ring-foreground")}>
                  <button type="button" onClick={() => setOpen(f._id)} className="block w-full">
                    <Thumb src={f.url} kind={f.type.startsWith("video/") ? "video" : "image"} className="aspect-square w-full" />
                  </button>
                  <div className={cn("absolute left-2 top-2 rounded bg-background/90", !sel.count && "opacity-0 group-hover:opacity-100")}><RowCheckbox sel={sel} id={f._id} label={`Select ${f.name}`} /></div>
                  <button type="button" aria-label="Copy link" title="Copy link" onClick={() => copy(f.url)} className="absolute right-2 top-2 rounded-md bg-background/90 p-1 opacity-0 shadow group-hover:opacity-100"><Copy className="size-3.5" /></button>
                  {f.type.startsWith("video/") && <Film className="absolute bottom-12 right-2 size-4 text-white drop-shadow" />}
                  <div className="px-2 py-1.5">
                    <div className="truncate text-xs font-medium" title={f.name}>{f.name}</div>
                    <div className="text-[11px] text-muted-foreground">{[ext(f), dims(f), f.size ? formatBytes(f.size) : ""].filter(Boolean).join(" · ")}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <IndexTable<F>
            rows={files} rowId={(f) => f._id} sel={sel} total={files.length} onRowClick={(f) => setOpen(f._id)}
            bulk={<Button size="sm" variant="outline" className="text-tone-red" onClick={deleteSelected}><Trash2 className="size-4" /> Delete files</Button>}
            columns={[
              { key: "file", label: "File name", render: (f) => (
                <div className="flex items-center gap-3">
                  <Thumb src={f.url} kind={f.type.startsWith("video/") ? "video" : "image"} className="size-10 shrink-0 rounded-md border" />
                  <div className="min-w-0"><div className="truncate font-semibold group-hover:underline">{f.name}</div><div className="text-xs text-muted-foreground">{ext(f)}</div></div>
                </div>
              ) },
              { key: "alt", label: "Alt text", hideBelow: "lg", render: (f) => <span className={cn("line-clamp-1", !f.alt && "text-muted-foreground")}>{f.alt || (f.type.startsWith("video/") ? "—" : "Add alt text")}</span> },
              { key: "date", label: "Date added", hideBelow: "md", render: (f) => <span className="text-muted-foreground">{ago(f.createdAt)}</span> },
              { key: "size", label: "Size", align: "right", hideBelow: "sm", render: (f) => <span className="text-muted-foreground">{f.size ? formatBytes(f.size) : "—"}</span> },
              { key: "dims", label: "Dimensions", align: "right", hideBelow: "md", render: (f) => <span className="text-muted-foreground">{dims(f) || "—"}</span> },
              { key: "link", label: "", align: "right", render: (f) => <Button size="icon-sm" variant="ghost" aria-label="Copy link" title="Copy link" onClick={(e) => { e.stopPropagation(); copy(f.url) }}><Copy className="size-3.5" /></Button> },
            ]}
          />
        )}
      </Card>
      <p className="mt-3 text-xs text-muted-foreground">Tip: drag files anywhere on this page to upload them. Use them in Themes → Customize, blog posts and Preferences.</p>

      <FileDialog file={current} onClose={() => setOpen(null)} />
    </div>
  )
}

function FileDialog({ file, onClose }: { file: F | null; onClose: () => void }) {
  const update = useMutation(api.files.update)
  const remove = useMutation(api.files.remove)
  const [alt, setAlt] = useState("")
  const [name, setName] = useState("")
  const [id, setId] = useState("")
  if (file && file._id !== id) { setId(file._id); setAlt(file.alt); setName(file.name) }
  const video = file?.type.startsWith("video/")
  return (
    <Dialog open={!!file} onOpenChange={(v) => { if (!v) { onClose(); setId("") } }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{file?.name}</DialogTitle>
          <DialogDescription>{file ? [ext(file), dims(file), file.size ? formatBytes(file.size) : "", `added ${ago(file.createdAt)}`].filter(Boolean).join(" · ") : ""}</DialogDescription>
        </DialogHeader>
        {file && (
          <div className="space-y-3">
            <div className="flex max-h-[45vh] justify-center overflow-hidden rounded-lg border bg-muted">
              {video ? <video src={file.url} controls className="max-h-[45vh]" /> : <img src={file.url} alt={file.alt} className="max-h-[45vh] object-contain" />}
            </div>
            <div className="flex gap-2">
              <Input readOnly value={file.url} className="h-9 font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button variant="outline" size="sm" className="h-9" onClick={() => copy(file.url)}><Copy className="size-4" /> Copy link</Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm"><span className="font-medium">Name</span><Input value={name} onChange={(e) => setName(e.target.value)} /></label>
              {!video && <label className="space-y-1 text-sm"><span className="font-medium">Alt text</span><Input value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="What the picture shows" /></label>}
            </div>
          </div>
        )}
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" className="text-tone-red" onClick={async () => {
            if (!file || !confirm("Delete this file? If a theme uses it, the website goes back to its built-in picture.")) return
            try { await remove({ ids: [file._id as Id<"webFiles">] }); onClose(); toast.success("Deleted") } catch (e) { toast.error(errMsg(e)) }
          }}><Trash2 className="size-4" /> Delete</Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Close</Button>
            <Button disabled={!file || (name === file.name && alt === file.alt)} onClick={async () => {
              if (!file) return
              try { await update({ id: file._id as Id<"webFiles">, name, alt }); toast.success("Saved") } catch (e) { toast.error(errMsg(e)) }
            }}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
