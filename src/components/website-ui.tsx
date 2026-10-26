// Building blocks for the Website editors (product + collection), modelled on Shopify Admin:
// a save bar that only appears when something changed, a rich description editor, a drag-to-reorder
// photo grid, a Google preview for SEO and a chip input for tags.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useBlocker } from "@tanstack/react-router"
import {
  Bold, Code2, GripVertical, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListOrdered, Loader2, MoreHorizontal,
  Pencil, Quote, RemoveFormatting, Star, Trash2, Underline, Undo2, X,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------- layout
export function Section({ title, sub, action, children, className, flush }: {
  title?: React.ReactNode; sub?: React.ReactNode; action?: React.ReactNode; children?: React.ReactNode; className?: string; flush?: boolean
}) {
  return (
    <section className={cn("rounded-xl border bg-card shadow-[0_1px_0_rgba(0,0,0,0.04)]", className)}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-3 px-4 pt-4">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
        </div>
      )}
      {children != null && children !== false && <div className={flush ? "pt-3" : "p-4"}>{children}</div>}
    </section>
  )
}

export function Field({ label, hint, children, className, right }: { label: React.ReactNode; hint?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2"><Label className="text-[13px] font-medium">{label}</Label>{right}</div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

// ---------------------------------------------------------------- unsaved changes
/** Tracks whether `value` differs from the last saved snapshot. */
export function useDirty<T>(value: T) {
  const [base, setBase] = useState(() => JSON.stringify(value))
  const now = JSON.stringify(value)
  return { dirty: now !== base, markSaved: useCallback((v?: T) => setBase(JSON.stringify(v ?? value)), [value]), base }
}

/** Shopify-style contextual save bar: slides in at the top when there are unsaved changes.
 *  Also: ⌘/Ctrl+S saves, and leaving the page asks first. */
export function SaveBar({ dirty, saving, onSave, onDiscard, message = "Unsaved changes" }: {
  dirty: boolean; saving: boolean; onSave: () => void; onDiscard: () => void; message?: string
}) {
  const save = useRef(onSave)
  save.current = onSave
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty && !saving) save.current() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [dirty, saving])
  useBlocker({
    shouldBlockFn: () => dirty && !saving && !window.confirm("You have unsaved changes. Leave this page and lose them?"),
    enableBeforeUnload: () => dirty && !saving,
  })
  return (
    <>
    {/* second copy at the bottom of the screen, where the eye already is after editing a field */}
    <div
      aria-hidden={!dirty}
      className={cn(
        "fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-neutral-900 py-2 pl-4 pr-2 text-white shadow-2xl ring-1 ring-black/10 transition-all duration-200",
        dirty ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-24 opacity-0",
      )}
    >
      <span className="flex items-center gap-2 whitespace-nowrap text-sm font-medium"><span className="size-2 rounded-full bg-amber-400" />{message}</span>
      <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" disabled={saving} onClick={onDiscard}>Discard</Button>
      <Button size="sm" className="bg-white text-neutral-900 hover:bg-white/90" disabled={saving} onClick={onSave}>
        {saving && <Loader2 className="size-4 animate-spin" />}{saving ? "Saving" : "Save"}
      </Button>
    </div>
    <div
      aria-hidden={!dirty}
      className={cn(
        "fixed inset-x-0 top-0 z-50 flex h-14 items-center gap-3 border-b border-white/10 bg-neutral-900 px-4 text-white shadow-lg transition-transform duration-200 md:px-6",
        dirty ? "translate-y-0" : "-translate-y-full",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium"><span className="size-2 rounded-full bg-amber-400" />{message}</span>
      <span className="hidden text-xs text-white/50 sm:inline">Ctrl + S to save</span>
      <div className="ml-auto flex gap-2">
        <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" disabled={saving} onClick={onDiscard}>Discard</Button>
        <Button size="sm" className="bg-white text-neutral-900 hover:bg-white/90" disabled={saving} onClick={onSave}>
          {saving && <Loader2 className="size-4 animate-spin" />}{saving ? "Saving" : "Save"}
        </Button>
      </div>
    </div>
    </>
  )
}

// ---------------------------------------------------------------- rich text
const TOOLS: { icon: typeof Bold; label: string; run: () => void; state?: string }[] = [
  { icon: Bold, label: "Bold", run: () => document.execCommand("bold"), state: "bold" },
  { icon: Italic, label: "Italic", run: () => document.execCommand("italic"), state: "italic" },
  { icon: Underline, label: "Underline", run: () => document.execCommand("underline"), state: "underline" },
  { icon: Heading2, label: "Heading", run: () => document.execCommand("formatBlock", false, "h2") },
  { icon: Heading3, label: "Subheading", run: () => document.execCommand("formatBlock", false, "h3") },
  { icon: List, label: "Bulleted list", run: () => document.execCommand("insertUnorderedList"), state: "insertUnorderedList" },
  { icon: ListOrdered, label: "Numbered list", run: () => document.execCommand("insertOrderedList"), state: "insertOrderedList" },
  { icon: Quote, label: "Quote", run: () => document.execCommand("formatBlock", false, "blockquote") },
]

/** Clean HTML coming out of the editor (drops editor-only styles and empty wrappers). */
function tidy(html: string) {
  return html
    .replace(/\s(style|class|data-[\w-]+)="[^"]*"/g, "")
    .replace(/<span>([\s\S]*?)<\/span>/g, "$1")
    .replace(/(<br>\s*)+$/g, "")
    .replace(/^<p><br><\/p>$/, "")
    .trim()
}

export function RichText({ value, onChange, placeholder = "Write a description…", minHeight = 220 }: {
  value: string; onChange: (html: string) => void; placeholder?: string; minHeight?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [code, setCode] = useState(false)
  const [active, setActive] = useState<Set<string>>(new Set())
  const last = useRef(value)

  // Only push outside changes into the editor (typing must not reset the caret)
  useEffect(() => {
    if (!code && ref.current && value !== last.current) { ref.current.innerHTML = value; last.current = value }
  }, [value, code])
  useEffect(() => { if (ref.current && !code) ref.current.innerHTML = value }, [code]) // eslint-disable-line react-hooks/exhaustive-deps

  const emit = () => { if (!ref.current) return; const h = tidy(ref.current.innerHTML); last.current = h; onChange(h) }
  const refresh = () => setActive(new Set(TOOLS.filter((t) => t.state && document.queryCommandState(t.state)).map((t) => t.state!)))
  const run = (fn: () => void) => { ref.current?.focus(); fn(); emit(); refresh() }

  return (
    <div className="overflow-hidden rounded-lg border bg-background focus-within:ring-2 focus-within:ring-ring/20">
      <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 px-1.5 py-1">
        {TOOLS.map((t) => (
          <ToolButton key={t.label} label={t.label} disabled={code} active={!!t.state && active.has(t.state)} onClick={() => run(t.run)}><t.icon className="size-4" /></ToolButton>
        ))}
        <Sep />
        <ToolButton label="Link" disabled={code} onClick={() => {
          const url = window.prompt("Link address (https://…)")
          if (url) run(() => document.execCommand("createLink", false, url))
        }}><Link2 className="size-4" /></ToolButton>
        <ToolButton label="Clear formatting" disabled={code} onClick={() => run(() => { document.execCommand("removeFormat"); document.execCommand("formatBlock", false, "p") })}><RemoveFormatting className="size-4" /></ToolButton>
        <ToolButton label="Undo" disabled={code} onClick={() => run(() => document.execCommand("undo"))}><Undo2 className="size-4" /></ToolButton>
        <div className="ml-auto">
          <ToolButton label={code ? "Back to editor" : "Edit HTML"} active={code} onClick={() => setCode((c) => !c)}><Code2 className="size-4" /></ToolButton>
        </div>
      </div>
      {code ? (
        <textarea
          value={value}
          onChange={(e) => { last.current = e.target.value; onChange(e.target.value) }}
          spellCheck={false}
          style={{ minHeight }}
          className="block w-full resize-y bg-background p-3 font-mono text-xs leading-relaxed outline-none"
        />
      ) : (
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline
          data-placeholder={placeholder}
          onInput={emit}
          onKeyUp={refresh}
          onMouseUp={refresh}
          onPaste={(e) => {
            // paste as clean text (keeps line breaks), never Word/website styling
            e.preventDefault()
            const text = e.clipboardData.getData("text/plain")
            document.execCommand("insertHTML", false, text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join(""))
          }}
          style={{ minHeight }}
          className={cn(
            "prose prose-sm max-h-[480px] max-w-none overflow-y-auto p-3 outline-none dark:prose-invert",
            "prose-headings:mb-2 prose-headings:mt-4 prose-p:my-2 prose-ul:my-2 prose-ol:my-2",
            "empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]",
          )}
        />
      )}
    </div>
  )
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function ToolButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        active && "bg-background text-foreground shadow-sm",
      )}
    >{children}</button>
  )
}
const Sep = () => <span className="mx-1 h-5 w-px bg-border" />

// ---------------------------------------------------------------- drag to reorder
/** Tiny HTML5 drag-and-drop list helper. */
export function useReorder<T>(items: T[], onChange: (next: T[]) => void) {
  const [drag, setDrag] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const props = (i: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)) },
    onDragOver: (e: React.DragEvent) => { if (drag === null) return; e.preventDefault(); if (over !== i) setOver(i) },
    onDrop: (e: React.DragEvent) => {
      if (drag === null) return
      e.preventDefault()
      if (drag !== i) { const n = [...items]; const [m] = n.splice(drag, 1); n.splice(i, 0, m); onChange(n) }
      setDrag(null); setOver(null)
    },
    onDragEnd: () => { setDrag(null); setOver(null) },
  })
  const move = (i: number, to: number) => { if (to < 0 || to >= items.length || to === i) return; const n = [...items]; const [m] = n.splice(i, 1); n.splice(to, 0, m); onChange(n) }
  return { props, drag, over, move }
}

// ---------------------------------------------------------------- media
export type Img = { url: string; alt: string; w: number | null; h: number | null }

export function MediaGrid({ images, onChange, onFiles, uploading, defaultAlt }: {
  images: Img[]; onChange: (next: Img[]) => void; onFiles: (files: File[]) => void; uploading: boolean; defaultAlt: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [hot, setHot] = useState(false)
  const { props, drag, over, move } = useReorder(images, onChange)
  const pick = () => fileRef.current?.click()
  const dropFiles = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("image/"))
    if (!files.length) return false
    e.preventDefault(); setHot(false); onFiles(files); return true
  }
  const addUrl = () => {
    const url = window.prompt("Photo address (https://…)")?.trim()
    if (!url) return
    if (!/^https?:\/\//.test(url)) { toast.error("That doesn't look like a web address"); return }
    onChange([...images, { url, alt: defaultAlt, w: null, h: null }])
  }

  return (
    <div
      onDragOver={(e) => { if (drag === null && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setHot(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHot(false) }}
      onDrop={(e) => { if (drag === null) dropFiles(e) }}
      className={cn("relative rounded-lg transition-colors", hot && "bg-primary/5 ring-2 ring-primary/30")}
    >
      <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { const f = Array.from(e.target.files ?? []); if (f.length) onFiles(f); e.target.value = "" }} />
      {images.length === 0 ? (
        <button type="button" onClick={pick} disabled={uploading} className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center hover:bg-muted/40">
          {uploading ? <Loader2 className="size-6 animate-spin text-muted-foreground" /> : <ImagePlus className="size-6 text-muted-foreground" />}
          <span className="text-sm font-medium">{uploading ? "Uploading…" : "Add photos"}</span>
          <span className="text-xs text-muted-foreground">or drop images here · JPG, PNG or WebP · square photos look best</span>
        </button>
      ) : (
        <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 lg:grid-cols-5">
          {images.map((img, i) => (
            <div
              key={img.url + i}
              {...props(i)}
              className={cn(
                "group relative cursor-grab overflow-hidden rounded-lg border bg-muted/30 active:cursor-grabbing",
                i === 0 && "col-span-2 row-span-2",
                drag === i && "opacity-40",
                over === i && drag !== i && "ring-2 ring-primary",
              )}
            >
              <img src={img.url} alt={img.alt} loading="lazy" draggable={false} className="aspect-square w-full object-cover" />
              {i === 0 && <span className="absolute left-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Main</span>}
              {!img.alt && <span className="absolute bottom-2 left-2 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 opacity-0 group-hover:opacity-100">No alt text</span>}
              <span className="absolute left-1.5 top-1/2 hidden -translate-y-1/2 rounded bg-white/90 p-0.5 text-neutral-600 shadow group-hover:block"><GripVertical className="size-3.5" /></span>
              <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <AltEditor value={img.alt} onChange={(alt) => onChange(images.map((x, j) => (j === i ? { ...x, alt } : x)))} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label="Photo options" className="inline-flex size-7 items-center justify-center rounded-md bg-white/95 text-neutral-700 shadow hover:bg-white"><MoreHorizontal className="size-4" /></button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {i !== 0 && <DropdownMenuItem onClick={() => move(i, 0)}><Star className="size-4" /> Make main photo</DropdownMenuItem>}
                    {i > 0 && <DropdownMenuItem onClick={() => move(i, i - 1)}>Move earlier</DropdownMenuItem>}
                    {i < images.length - 1 && <DropdownMenuItem onClick={() => move(i, i + 1)}>Move later</DropdownMenuItem>}
                    <DropdownMenuItem asChild><a href={img.url} target="_blank" rel="noreferrer">Open full size</a></DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-tone-red focus:text-tone-red" onClick={() => onChange(images.filter((_, j) => j !== i))}><Trash2 className="size-4" /> Remove</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
          <button type="button" onClick={pick} disabled={uploading} className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed text-xs text-muted-foreground hover:bg-muted/40">
            {uploading ? <Loader2 className="size-5 animate-spin" /> : <ImagePlus className="size-5" />}{uploading ? "Uploading" : "Add"}
          </button>
        </div>
      )}
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{images.length ? "Drag to reorder · the first photo is the main one" : ""}</span>
        <button type="button" onClick={addUrl} className="underline-offset-2 hover:text-foreground hover:underline">Add from URL</button>
      </div>
      {hot && <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg text-sm font-medium text-primary">Drop to upload</div>}
    </div>
  )
}

function AltEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [v, setV] = useState(value)
  return (
    <Popover onOpenChange={(o) => o && setV(value)}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Edit alt text" className="inline-flex size-7 items-center justify-center rounded-md bg-white/95 text-neutral-700 shadow hover:bg-white"><Pencil className="size-3.5" /></button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2">
        <Label className="text-xs">Alt text</Label>
        <Textarea rows={2} value={v} onChange={(e) => setV(e.target.value)} placeholder="Describe the photo, e.g. Black leather sandal, side view" />
        <p className="text-[11px] text-muted-foreground">Helps Google Images and screen readers.</p>
        <div className="flex justify-end"><Button size="sm" onClick={() => onChange(v.trim())}>Done</Button></div>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------- SEO
export function SeoCard({ path, handle, onHandle, title, onTitle, desc, onDesc, fallbackTitle, fallbackDesc, site }: {
  path: string; handle: string; onHandle: (v: string) => void
  title: string; onTitle: (v: string) => void; desc: string; onDesc: (v: string) => void
  fallbackTitle: string; fallbackDesc: string; site: string
}) {
  const [open, setOpen] = useState(false)
  const t = (title || fallbackTitle || "").trim()
  const d = (desc || fallbackDesc || "").replace(/\s+/g, " ").trim()
  const host = site.replace(/^https?:\/\//, "")
  return (
    <Section title="Search engine listing" sub={open ? "How this page shows up on Google." : undefined}
      action={<Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>{open ? "Done" : <><Pencil className="size-3.5" /> Edit</>}</Button>}>
      <div className="rounded-lg border bg-background p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex size-6 items-center justify-center rounded-full bg-neutral-900 text-[9px] font-bold text-white">BB</span>
          <div className="min-w-0 leading-tight"><div className="text-foreground">BlackBole</div><div className="truncate">{host} › {path} › {handle || "…"}</div></div>
        </div>
        <div className="mt-1.5 line-clamp-1 text-[17px] leading-snug text-[#1a0dab] dark:text-[#8ab4f8]">{t || "Add a title"}</div>
        <div className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">{d || "Add a description so shoppers know what they'll find."}</div>
      </div>
      {open && (
        <div className="mt-4 space-y-4">
          <Field label="Page title" right={<Count n={t.length} max={70} />}>
            <Input value={title} placeholder={fallbackTitle} onChange={(e) => onTitle(e.target.value)} />
          </Field>
          <Field label="Meta description" right={<Count n={d.length} max={160} />}>
            <Textarea rows={3} value={desc} placeholder={fallbackDesc.slice(0, 160)} onChange={(e) => onDesc(e.target.value)} />
          </Field>
          <Field label="URL handle" hint="Changing it changes the page's web address. The old address keeps working on the website only if you add a redirect.">
            <div className="flex items-center overflow-hidden rounded-md border bg-muted/40 text-sm focus-within:ring-2 focus-within:ring-ring/20">
              <span className="whitespace-nowrap pl-3 text-muted-foreground">/{path}/</span>
              <input value={handle} onChange={(e) => onHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))} className="h-9 min-w-0 flex-1 bg-background px-2 outline-none" />
            </div>
          </Field>
        </div>
      )}
    </Section>
  )
}

function Count({ n, max }: { n: number; max: number }) {
  return <span className={cn("text-xs tabular-nums", n > max ? "text-tone-red" : "text-muted-foreground")}>{n} / {max}</span>
}

// ---------------------------------------------------------------- tags
export function TagInput({ value, onChange, suggestions, placeholder = "Add a tag" }: { value: string[]; onChange: (v: string[]) => void; suggestions: string[]; placeholder?: string }) {
  const [q, setQ] = useState("")
  const [open, setOpen] = useState(false)
  const lower = new Set(value.map((t) => t.toLowerCase()))
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return suggestions.filter((t) => !lower.has(t.toLowerCase()) && (!s || t.toLowerCase().includes(s))).slice(0, 8)
  }, [q, suggestions, value]) // eslint-disable-line react-hooks/exhaustive-deps
  const add = (t: string) => { const x = t.trim(); if (x && !lower.has(x.toLowerCase())) onChange([...value, x]); setQ("") }
  return (
    <div className="relative">
      <Input
        value={q}
        placeholder={placeholder}
        onChange={(e) => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === ",") && q.trim()) { e.preventDefault(); add(q) }
          if (e.key === "Backspace" && !q && value.length) onChange(value.slice(0, -1))
        }}
      />
      {open && (list.length > 0 || q.trim()) && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md">
          {q.trim() && !lower.has(q.trim().toLowerCase()) && !suggestions.some((s) => s.toLowerCase() === q.trim().toLowerCase()) && (
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(q)} className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent">Add “{q.trim()}”</button>
          )}
          {list.map((t) => <button key={t} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(t)} className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent">{t}</button>)}
        </div>
      )}
      {value.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {value.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
              {t}
              <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))} className="text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Text input with a suggestion list (type, vendor). */
export function SuggestInput({ value, onChange, suggestions, placeholder }: { value: string; onChange: (v: string) => void; suggestions: string[]; placeholder?: string }) {
  const id = useMemo(() => `s-${Math.random().toString(36).slice(2)}`, [])
  return (
    <>
      <Input value={value} placeholder={placeholder} list={id} onChange={(e) => onChange(e.target.value)} />
      <datalist id={id}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
    </>
  )
}

// ---------------------------------------------------------------- status
export function StatusBadge({ on, label }: { on: boolean; label?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold", on ? "bg-tone-green-bg text-tone-green" : "bg-tone-gray-bg text-tone-gray")}>
      <span className={cn("size-1.5 rounded-full", on ? "bg-tone-green" : "bg-tone-gray")} />
      {label ?? (on ? "On website" : "Hidden")}
    </span>
  )
}

/** Upload files to Convex storage; returns website-ready image rows. */
export async function uploadImages(files: File[], getUploadUrl: () => Promise<string>, getFileUrl: (a: { storageId: any }) => Promise<string>, alt: string) {
  const out: Img[] = []
  for (const f of files) {
    if (f.size > 15 * 1024 * 1024) { toast.error(`${f.name} is larger than 15 MB`); continue }
    const url = await getUploadUrl()
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f })
    if (!res.ok) throw new Error(`Upload failed (${f.name})`)
    const { storageId } = await res.json()
    const publicUrl = await getFileUrl({ storageId })
    const size = await imageSize(f)
    out.push({ url: publicUrl, alt, w: size?.w ?? null, h: size?.h ?? null })
  }
  return out
}

function imageSize(f: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f)
    const img = new Image()
    img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url) }
    img.onerror = () => { resolve(null); URL.revokeObjectURL(url) }
    img.src = url
  })
}

export const SITE_URL = "https://blackbole.com"
export const PREVIEW_URL = "https://blackbole-site.pages.dev"
