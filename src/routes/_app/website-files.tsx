import { useRef, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { Copy, Film, Loader2, Search, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { WebsiteHeader, ago } from "@/components/content-ui"
import { ACCEPT, Thumb, formatBytes, useUploadFiles } from "@/components/file-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/website-files")({
  component: () => <WebsiteGuard><Files /></WebsiteGuard>,
})

type Kind = "all" | "image" | "video"

function Files() {
  const [q, setQ] = useState("")
  const [kind, setKind] = useState<Kind>("all")
  const files = useQuery(api.files.list, { q, kind })
  const { upload, busy } = useUploadFiles()
  const remove = useMutation(api.files.remove)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const current = files?.find((f) => f._id === open) ?? null

  const doUpload = async (list: File[]) => {
    if (!list.length) return
    const urls = await upload(list)
    if (urls.length) toast.success(urls.length === 1 ? "Uploaded" : `${urls.length} files uploaded`)
  }
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <div className="mx-auto max-w-6xl"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrag(true) } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false) }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); doUpload(Array.from(e.dataTransfer.files)) }}>
      <WebsiteHeader active="files" sub="Pictures and videos for the website: banners, category tiles, theme pictures.">
        <Button size="sm" onClick={() => input.current?.click()} disabled={busy > 0}>
          {busy > 0 ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} {busy > 0 ? `Uploading ${busy}…` : "Upload files"}
        </Button>
        <input ref={input} type="file" hidden multiple accept={ACCEPT.all} onChange={(e) => { doUpload(Array.from(e.target.files ?? [])); e.target.value = "" }} />
      </WebsiteHeader>

      <div className={cn("overflow-hidden rounded-xl border bg-card", drag && "ring-2 ring-foreground")}>
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="relative min-w-48 max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files" className="h-8 border-0 bg-transparent pl-8 shadow-none focus-visible:ring-0" />
          </div>
          <div className="flex rounded-md border p-0.5 text-xs">
            {(["all", "image", "video"] as Kind[]).map((k) => (
              <button key={k} type="button" onClick={() => setKind(k)} className={cn("rounded px-2.5 py-1", kind === k ? "bg-muted font-medium" : "text-muted-foreground")}>
                {k === "all" ? "All" : k === "image" ? "Pictures" : "Videos"}
              </button>
            ))}
          </div>
          {sel.size > 0 && (
            <div className="ml-auto flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{sel.size} selected</span>
              <Button size="sm" variant="outline" onClick={() => setSel(new Set())}>Clear</Button>
              <Button size="sm" variant="destructive" onClick={async () => {
                if (!confirm(`Delete ${sel.size} file${sel.size > 1 ? "s" : ""}? Pictures a theme still uses go back to the website's built-in ones.`)) return
                try { await remove({ ids: [...sel] as Id<"webFiles">[] }); setSel(new Set()); toast.success("Deleted") } catch (e) { toast.error(errMsg(e)) }
              }}><Trash2 className="size-4" /> Delete</Button>
            </div>
          )}
        </div>

        {files === undefined ? <Loading /> : files === null ? null : files.length === 0 ? (
          <button type="button" onClick={() => input.current?.click()} className="flex w-full flex-col items-center justify-center gap-2 py-20 text-center">
            <div className="flex size-11 items-center justify-center rounded-full bg-muted"><Upload className="size-5" /></div>
            <div className="font-medium">{q || kind !== "all" ? "No file matches" : "Upload your first file"}</div>
            <div className="max-w-sm text-sm text-muted-foreground">Drop pictures or videos here, or click to choose them. JPG, PNG, WebP, GIF or MP4, up to 50 MB each.</div>
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {files.map((f) => (
              <div key={f._id} className={cn("group relative overflow-hidden rounded-lg border bg-background", sel.has(f._id) && "ring-2 ring-foreground")}>
                <button type="button" onClick={() => setOpen(f._id)} className="block w-full">
                  <Thumb src={f.url} kind={f.type.startsWith("video/") ? "video" : "image"} className="aspect-square w-full" />
                </button>
                <input type="checkbox" checked={sel.has(f._id)} onChange={() => toggle(f._id)} aria-label="Select"
                  className={cn("absolute left-2 top-2 size-4 cursor-pointer accent-foreground", !sel.size && "opacity-0 group-hover:opacity-100")} />
                {f.type.startsWith("video/") && <Film className="absolute right-2 top-2 size-4 text-white drop-shadow" />}
                <div className="px-2 py-1.5">
                  <div className="truncate text-xs font-medium">{f.name}</div>
                  <div className="text-[11px] text-muted-foreground">{f.w && f.h ? `${f.w} × ${f.h} · ` : ""}{formatBytes(f.size)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Tip: drag files anywhere on this page to upload them. Use them in Themes → Customize.</p>

      <FileDialog file={current} onClose={() => setOpen(null)} />
    </div>
  )
}

function FileDialog({ file, onClose }: { file: { _id: string; url: string; name: string; type: string; size: number; w: number | null; h: number | null; alt: string; createdAt: number } | null; onClose: () => void }) {
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
          <DialogDescription>{file ? `${file.w && file.h ? `${file.w} × ${file.h} · ` : ""}${formatBytes(file.size)} · uploaded ${ago(file.createdAt)}` : ""}</DialogDescription>
        </DialogHeader>
        {file && (
          <div className="space-y-3">
            <div className="flex max-h-[45vh] justify-center overflow-hidden rounded-lg border bg-muted">
              {video ? <video src={file.url} controls className="max-h-[45vh]" /> : <img src={file.url} alt={file.alt} className="max-h-[45vh] object-contain" />}
            </div>
            <div className="flex gap-2">
              <Input readOnly value={file.url} className="h-9 font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button variant="outline" size="sm" className="h-9" onClick={() => { navigator.clipboard.writeText(file.url); toast.success("Link copied") }}><Copy className="size-4" /> Copy link</Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm"><span className="font-medium">Name</span><Input value={name} onChange={(e) => setName(e.target.value)} /></label>
              {!video && <label className="space-y-1 text-sm"><span className="font-medium">Description (alt text)</span><Input value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="What the picture shows" /></label>}
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

