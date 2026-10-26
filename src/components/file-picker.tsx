// Website → Files: upload pictures/videos, choose one from the library (used by the theme editor's picture fields).
import { useRef, useState } from "react"
import { useMutation, useQuery } from "convex/react"
import { Check, Film, ImageIcon, Loader2, Search, Upload, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export type FileKind = "image" | "video"
export const ACCEPT: Record<FileKind | "all", string> = {
  image: "image/jpeg,image/png,image/webp,image/gif,image/avif,image/svg+xml",
  video: "video/mp4,video/webm,video/quicktime",
  all: "image/jpeg,image/png,image/webp,image/gif,image/avif,image/svg+xml,video/mp4,video/webm,video/quicktime",
}

function mediaSize(f: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f)
    const done = (r: { w: number; h: number } | null) => { URL.revokeObjectURL(url); resolve(r) }
    if (f.type.startsWith("video/")) {
      const el = document.createElement("video")
      el.preload = "metadata"
      el.onloadedmetadata = () => done({ w: el.videoWidth, h: el.videoHeight })
      el.onerror = () => done(null)
      el.src = url
    } else {
      const img = new Image()
      img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight })
      img.onerror = () => done(null)
      img.src = url
    }
    setTimeout(() => done(null), 8000)
  })
}

/** Uploads files to Website → Files; returns their public links. */
export function useUploadFiles() {
  const getUrl = useMutation(api.files.uploadUrl)
  const add = useMutation(api.files.add)
  const [busy, setBusy] = useState(0)
  const upload = async (files: File[]) => {
    const urls: string[] = []
    setBusy(files.length)
    try {
      for (const f of files) {
        if (f.size > 50 * 1024 * 1024) { toast.error(`${f.name} is larger than 50 MB`); continue }
        try {
          const size = await mediaSize(f)
          const post = await getUrl()
          const res = await fetch(post, { method: "POST", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f })
          if (!res.ok) throw new Error(`Upload failed (${f.name})`)
          const { storageId } = await res.json()
          const r = await add({ storageId, name: f.name, type: f.type || "application/octet-stream", size: f.size, ...(size ? { w: size.w, h: size.h } : {}) })
          urls.push(r.url)
        } catch (e) {
          toast.error(errMsg(e))
        }
        setBusy((n) => Math.max(0, n - 1))
      }
    } finally { setBusy(0) }
    return urls
  }
  return { upload, busy }
}

export const isVideoUrl = (u: string) => /\.(mp4|webm|mov)(\?|$)/i.test(u)
export function Thumb({ src, kind, className }: { src: string; kind?: FileKind; className?: string }) {
  if (!src) return <div className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)}><ImageIcon className="size-5" /></div>
  if (kind === "video" || isVideoUrl(src)) return <video src={src} muted playsInline preload="metadata" className={cn("bg-black object-cover", className)} />
  return <img src={src} alt="" loading="lazy" className={cn("bg-muted object-cover", className)} />
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Pick a picture or video from Website → Files, or upload a new one. */
export function FilePickerDialog({ open, onOpenChange, kind, onPick, title }: {
  open: boolean; onOpenChange: (v: boolean) => void; kind: FileKind; onPick: (url: string) => void; title?: string
}) {
  const [q, setQ] = useState("")
  const files = useQuery(api.files.list, open ? { q, kind } : "skip")
  const { upload, busy } = useUploadFiles()
  const [sel, setSel] = useState("")
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const doUpload = async (list: File[]) => {
    const ok = list.filter((f) => f.type.startsWith(kind + "/"))
    if (ok.length < list.length) toast.error(kind === "image" ? "Only pictures can be used here" : "Only videos can be used here")
    if (!ok.length) return
    const urls = await upload(ok)
    if (urls[0]) setSel(urls[0])
  }
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setSel("") }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title ?? (kind === "image" ? "Choose a picture" : "Choose a video")}</DialogTitle>
          <DialogDescription>From Website → Files, or upload a new one from your computer or phone.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files" className="h-9 pl-8" />
          </div>
          <Button size="sm" onClick={() => input.current?.click()} disabled={busy > 0}>
            {busy > 0 ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} {busy > 0 ? `Uploading ${busy}…` : "Upload"}
          </Button>
          <input ref={input} type="file" hidden multiple accept={ACCEPT[kind]} onChange={(e) => { doUpload(Array.from(e.target.files ?? [])); e.target.value = "" }} />
        </div>
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); doUpload(Array.from(e.dataTransfer.files)) }}
          className={cn("max-h-[55vh] min-h-56 overflow-y-auto rounded-lg border border-dashed p-2", drag && "border-foreground bg-muted/50")}
        >
          {files === undefined ? <div className="p-10 text-center text-sm text-muted-foreground">Loading…</div>
            : !files?.length ? (
              <button type="button" onClick={() => input.current?.click()} className="flex h-52 w-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                {kind === "image" ? <ImageIcon className="size-6" /> : <Film className="size-6" />}
                {q ? "No file matches." : `No ${kind === "image" ? "pictures" : "videos"} yet. Drop files here or click to upload.`}
              </button>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
                {files.map((f) => (
                  <button key={f._id} type="button" onClick={() => setSel(f.url)} onDoubleClick={() => { onPick(f.url); onOpenChange(false) }}
                    className={cn("group relative overflow-hidden rounded-md border text-left", sel === f.url ? "ring-2 ring-foreground" : "hover:border-foreground/40")}>
                    <Thumb src={f.url} kind={f.type.startsWith("video/") ? "video" : "image"} className="aspect-square w-full" />
                    <div className="truncate px-1.5 py-1 text-[11px] text-muted-foreground">{f.name}</div>
                    {sel === f.url && <span className="absolute right-1 top-1 rounded-full bg-foreground p-0.5 text-background"><Check className="size-3" /></span>}
                  </button>
                ))}
              </div>
            )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!sel} onClick={() => { onPick(sel); onOpenChange(false); setSel("") }}>Use this {kind === "image" ? "picture" : "video"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A picture/video setting: shows what the website uses now, with Change and Reset. */
export function MediaField({ value, onChange, kind, fallback }: { value: string; onChange: (v: string) => void; kind: FileKind; fallback?: string }) {
  const [open, setOpen] = useState(false)
  const { upload, busy } = useUploadFiles()
  const input = useRef<HTMLInputElement>(null)
  const shown = value || fallback || ""
  return (
    <div className="rounded-lg border bg-background p-2">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setOpen(true)} className="shrink-0 overflow-hidden rounded-md border">
          <Thumb src={shown} kind={kind} className="h-16 w-24" />
        </button>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="truncate text-xs text-muted-foreground">{value ? "Your " + (kind === "image" ? "picture" : "video") : fallback ? "Website’s built-in " + (kind === "image" ? "picture" : "video") : "None"}</div>
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setOpen(true)}>Select</Button>
            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy > 0} onClick={() => input.current?.click()}>
              {busy > 0 ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Upload
            </Button>
            {value && <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => onChange("")}><X className="size-3.5" /> Remove</Button>}
          </div>
        </div>
      </div>
      <input ref={input} type="file" hidden accept={ACCEPT[kind]} onChange={async (e) => {
        const f = e.target.files?.[0]
        e.target.value = ""
        if (!f) return
        if (!f.type.startsWith(kind + "/")) { toast.error(kind === "image" ? "Choose a picture" : "Choose a video"); return }
        const [u] = await upload([f])
        if (u) onChange(u)
      }} />
      <FilePickerDialog open={open} onOpenChange={setOpen} kind={kind} onPick={onChange} />
    </div>
  )
}
