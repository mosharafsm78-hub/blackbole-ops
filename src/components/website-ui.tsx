// Building blocks for the Website editors (product + collection), modelled on Shopify Admin:
// a save bar that only appears when something changed, a rich description editor, a drag-to-reorder
// photo grid, a Google preview for SEO and a chip input for tags.
// Also the shared Shopify-style (Polaris look) pieces: Card, Badge, PageHeader, EmptyState and index table helpers.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useBlocker } from "@tanstack/react-router"
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Bold, ChevronDown, Code2, GripVertical, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListOrdered, Loader2, MoreHorizontal,
  Pencil, Plus, Quote, RemoveFormatting, Search, Star, Trash2, Underline, Undo2, X,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------- layout
/** Polaris card surface: white, 12px corners, hairline edge and a soft bottom shadow. */
export const CARD = "rounded-xl border border-black/[0.08] bg-card shadow-[0_1px_0_0_rgba(26,26,26,0.07)] dark:border-white/10 dark:shadow-none"

export function Section({ title, sub, action, children, className, flush }: {
  title?: React.ReactNode; sub?: React.ReactNode; action?: React.ReactNode; children?: React.ReactNode; className?: string; flush?: boolean
}) {
  return (
    <section className={cn(CARD, className)}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-3 px-4 pt-4">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-semibold leading-5">{title}</h2>}
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
      <span className="flex items-center gap-2 whitespace-nowrap text-sm font-medium"><AlertTriangle className="size-4 text-amber-300" />{message}</span>
      <Button size="sm" variant="ghost" className={DISCARD} disabled={saving} onClick={onDiscard}>Discard</Button>
      <Button size="sm" className={SAVE} disabled={saving} onClick={onSave}>
        {saving && <Loader2 className="size-4 animate-spin" />}{saving ? "Saving" : "Save"}
      </Button>
    </div>
    <div
      aria-hidden={!dirty}
      className={cn(
        "fixed inset-x-0 top-0 z-50 flex h-14 items-center bg-[#1a1a1a] px-4 text-white shadow-lg transition-transform duration-200 md:px-6",
        dirty ? "translate-y-0" : "-translate-y-full",
      )}
    >
      <div className="mx-auto flex w-full max-w-5xl items-center gap-3">
      <span className="flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="size-4 text-amber-300" />{message}</span>
      <span className="hidden text-xs text-white/50 sm:inline">Ctrl + S to save</span>
      <div className="ml-auto flex gap-2">
        <Button size="sm" variant="ghost" className={DISCARD} disabled={saving} onClick={onDiscard}>Discard</Button>
        <Button size="sm" className={SAVE} disabled={saving} onClick={onSave}>
          {saving && <Loader2 className="size-4 animate-spin" />}{saving ? "Saving" : "Save"}
        </Button>
      </div>
      </div>
    </div>
    </>
  )
}
const DISCARD = "h-8 rounded-lg border border-white/25 bg-white/5 text-white hover:bg-white/15 hover:text-white"
const SAVE = "h-8 rounded-lg bg-white font-semibold text-[#1a1a1a] shadow-[inset_0_-1px_0_rgba(0,0,0,0.2)] hover:bg-white/90"

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
/** On/off badge (kept for older pages), now with Polaris colours.
 *  Pass `status` for Shopify's product states: Active = green, Draft = blue, Archived = grey. */
export type ItemStatus = "active" | "draft" | "archived"
export function StatusBadge({ on, label, status }: { on: boolean; label?: string; status?: ItemStatus }) {
  if (status) return <Badge tone={STATUS_TONE[status]}>{label ?? STATUS_TEXT[status]}</Badge>
  return <Badge tone={on ? "success" : "neutral"}>{label ?? (on ? "On website" : "Hidden")}</Badge>
}
const STATUS_TONE: Record<ItemStatus, BadgeTone> = { active: "success", draft: "info", archived: "neutral" }
const STATUS_TEXT: Record<ItemStatus, string> = { active: "Active", draft: "Draft", archived: "Archived" }

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

// ================================================================ Shopify-style building blocks
// Small, dependency-free versions of the Polaris pieces Shopify Admin uses. Pages can adopt them one at a time.

// ---------------------------------------------------------------- Card
/** A Polaris card. `flush` drops the inner padding (for tables and lists that run edge to edge). */
export function Card({ children, className, flush, title, action }: {
  children?: React.ReactNode; className?: string; flush?: boolean; title?: React.ReactNode; action?: React.ReactNode
}) {
  return (
    <section className={cn(CARD, flush && "overflow-hidden", className)}>
      {(title || action) && (
        <div className={cn("flex items-center justify-between gap-3", flush ? "px-4 pb-2 pt-3" : "px-4 pt-4")}>
          {title && <h2 className="text-[13px] font-semibold leading-5">{title}</h2>}
          {action && <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div>}
        </div>
      )}
      {flush ? children : <div className={cn("p-4", (title || action) && "pt-3")}>{children}</div>}
    </section>
  )
}

// ---------------------------------------------------------------- Badge
export type BadgeTone = "neutral" | "success" | "info" | "attention" | "warning" | "critical" | "new"
const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "bg-black/[0.06] text-foreground/75 dark:bg-white/10",
  success: "bg-tone-green-bg text-tone-green",
  info: "bg-tone-blue-bg text-tone-blue",
  attention: "bg-tone-amber-bg text-tone-amber",
  warning: "bg-tone-orange-bg text-tone-orange",
  critical: "bg-tone-red-bg text-tone-red",
  new: "bg-tone-violet-bg text-tone-violet",
}
/** Polaris badge: small rounded pill with a soft colour. `dot` adds the little progress circle. */
export function Badge({ tone = "neutral", dot, children, className }: { tone?: BadgeTone; dot?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-0.5 text-xs font-medium leading-4", BADGE_TONE[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  )
}

// ---------------------------------------------------------------- Page header
export type HeaderAction = {
  label: string; onClick?: () => void; href?: string; icon?: React.ReactNode; destructive?: boolean; disabled?: boolean
}
/** Shopify page header: back arrow, title with badges, then secondary buttons, "More actions" and the main button on the right. */
export function PageHeader({ title, back, onBack, badges, subtitle, primary, secondary, more, moreLabel = "More actions", className }: {
  title: React.ReactNode
  /** Where the back arrow goes, e.g. { to: "/website-pages" }. */
  back?: { to: string; search?: Record<string, unknown>; label?: string }
  onBack?: () => void
  badges?: React.ReactNode
  subtitle?: React.ReactNode
  /** The main action (dark button), e.g. <Button size="sm">Add product</Button>. */
  primary?: React.ReactNode
  /** Plain buttons shown before "More actions". */
  secondary?: React.ReactNode
  more?: HeaderAction[]
  moreLabel?: string
  className?: string
}) {
  const backCls = "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/10"
  return (
    <div className={cn("mb-4 flex flex-wrap items-start justify-between gap-x-3 gap-y-2", className)}>
      <div className="flex min-w-0 items-start gap-1.5">
        {back && (
          <Link to={back.to as "/website"} search={back.search as never} aria-label={back.label ?? "Back"} title={back.label ?? "Back"} className={backCls}>
            <ArrowLeft className="size-4" />
          </Link>
        )}
        {!back && onBack && <button type="button" onClick={onBack} aria-label="Back" className={backCls}><ArrowLeft className="size-4" /></button>}
        <div className="min-w-0 pt-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-bold leading-7 tracking-tight">{title}</h1>
            {badges}
          </div>
          {subtitle && <p className="mt-0.5 text-[13px] text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {(primary || secondary || (more && more.length > 0)) && (
        <div className="flex flex-wrap items-center gap-2">
          {secondary}
          {more && more.length > 0 && <MoreActions label={moreLabel} actions={more} />}
          {primary}
        </div>
      )}
    </div>
  )
}

/** "More actions ▾" dropdown used in page headers and bulk bars. */
export function MoreActions({ actions, label = "More actions", size = "sm" }: { actions: HeaderAction[]; label?: string; size?: "sm" | "icon" }) {
  const safe = actions.filter((a) => !a.destructive)
  const danger = actions.filter((a) => a.destructive)
  const item = (a: HeaderAction) => a.href
    ? <DropdownMenuItem key={a.label} asChild disabled={a.disabled}><a href={a.href} target="_blank" rel="noreferrer">{a.icon}{a.label}</a></DropdownMenuItem>
    : <DropdownMenuItem key={a.label} disabled={a.disabled} onClick={a.onClick} className={a.destructive ? "text-tone-red focus:text-tone-red" : undefined}>{a.icon}{a.label}</DropdownMenuItem>
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {size === "icon"
          ? <Button size="icon-sm" variant="outline" aria-label={label}><MoreHorizontal className="size-4" /></Button>
          : <Button size="sm" variant="outline">{label}<ChevronDown className="size-3.5" /></Button>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {safe.map(item)}
        {safe.length > 0 && danger.length > 0 && <DropdownMenuSeparator />}
        {danger.map(item)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------- Empty state
/** Polaris empty state: centred picture, heading, one line of help and the buttons to get started. */
export function EmptyState({ icon, image, title, text, primary, secondary, footer, className }: {
  icon?: React.ReactNode; image?: string; title: React.ReactNode; text?: React.ReactNode
  primary?: React.ReactNode; secondary?: React.ReactNode; footer?: React.ReactNode; className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      {image ? <img src={image} alt="" className="mb-4 h-32 w-auto" loading="lazy" />
        : icon ? <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-black/[0.05] text-muted-foreground dark:bg-white/10 [&_svg]:size-6">{icon}</div>
        : null}
      <h2 className="text-base font-semibold">{title}</h2>
      {text && <p className="mt-1 max-w-md text-[13px] text-muted-foreground">{text}</p>}
      {(primary || secondary) && <div className="mt-4 flex flex-wrap justify-center gap-2">{secondary}{primary}</div>}
      {footer && <div className="mt-6 text-xs text-muted-foreground">{footer}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- Index tables
/** Class names for hand-built tables that should look like a Shopify index table. */
export const INDEX = {
  table: "w-full border-collapse text-[13px]",
  th: "h-9 whitespace-nowrap border-b border-black/[0.08] bg-black/[0.03] px-3 text-left text-xs font-medium text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]",
  tr: "group border-b border-black/[0.06] transition-colors last:border-0 hover:bg-black/[0.03] data-[selected=true]:bg-black/[0.05] dark:border-white/[0.06] dark:hover:bg-white/[0.03] dark:data-[selected=true]:bg-white/[0.06]",
  td: "px-3 py-2.5 align-middle",
  check: "w-10 pl-4 pr-0",
}

/** Which rows are ticked. Unticks rows that disappear (e.g. after a filter or delete). */
export function useSelection(ids: string[]) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const key = ids.join("|")
  useEffect(() => {
    setPicked((p) => {
      const keep = new Set([...p].filter((id) => ids.includes(id)))
      return keep.size === p.size ? p : keep
    })
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const count = picked.size
  const all = ids.length > 0 && count === ids.length
  return {
    selected: picked,
    count,
    all,
    some: count > 0 && !all,
    has: (id: string) => picked.has(id),
    toggle: (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n }),
    toggleAll: () => setPicked(all ? new Set() : new Set(ids)),
    set: (next: string[]) => setPicked(new Set(next)),
    clear: () => setPicked(new Set()),
  }
}
export type Selection = ReturnType<typeof useSelection>

/** Header checkbox: ticks every row; shows a dash when only some are ticked. */
export function SelectAllCheckbox({ sel, label = "Select all" }: { sel: Selection; label?: string }) {
  return <Checkbox aria-label={label} checked={sel.all ? true : sel.some ? "indeterminate" : false} onCheckedChange={() => sel.toggleAll()} className={cn(CHECK, sel.some && DASH)} />
}
export function RowCheckbox({ sel, id, label = "Select row" }: { sel: Selection; id: string; label?: string }) {
  return <Checkbox aria-label={label} checked={sel.has(id)} onCheckedChange={() => sel.toggle(id)} onClick={(e) => e.stopPropagation()} className={CHECK} />
}
const CHECK = "rounded-[5px] border-black/30 data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground dark:border-white/30"
// "some ticked": hide the tick and draw a dash instead
const DASH = "relative [&_svg]:hidden after:absolute after:left-1/2 after:top-1/2 after:h-0.5 after:w-2 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:bg-current"

/** Replaces the table header while rows are ticked: "3 selected" + bulk buttons, like Shopify. */
export function BulkBar({ sel, total, children, more }: { sel: Selection; total?: number; children?: React.ReactNode; more?: HeaderAction[] }) {
  if (sel.count === 0) return null
  return (
    <div className="flex h-11 items-center gap-3 border-b border-black/[0.08] bg-card px-4 dark:border-white/10" role="toolbar" aria-label="Bulk actions">
      <SelectAllCheckbox sel={sel} />
      <span className="text-[13px] font-semibold">{sel.count} selected</span>
      {total != null && !sel.all && total > sel.count && (
        <button type="button" onClick={sel.toggleAll} className="text-[13px] text-tone-blue hover:underline">Select all {total}</button>
      )}
      <div className="ml-auto flex items-center gap-2">
        {children}
        {more && more.length > 0 && <MoreActions actions={more} size="icon" label="More bulk actions" />}
      </div>
    </div>
  )
}

export type SortDir = "asc" | "desc"
/** Clickable column heading that sorts. Shows an arrow on the active column. */
export function SortHeader({ label, active, dir, onSort, align = "left", className }: {
  label: React.ReactNode; active: boolean; dir: SortDir; onSort: () => void; align?: "left" | "right"; className?: string
}) {
  const Icon = dir === "asc" ? ArrowUp : ArrowDown
  return (
    <th className={cn(INDEX.th, align === "right" && "text-right", className)} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={onSort} className={cn("group/sort inline-flex items-center gap-1 rounded hover:text-foreground", active && "text-foreground", align === "right" && "flex-row-reverse")}>
        {label}
        <Icon className={cn("size-3", active ? "opacity-100" : "opacity-0 group-hover/sort:opacity-50")} />
      </button>
    </th>
  )
}

/** Sort state helper: click the same column again to flip the direction. */
export function useSort<K extends string>(initial: K, initialDir: SortDir = "desc") {
  const [by, setBy] = useState<K>(initial)
  const [dir, setDir] = useState<SortDir>(initialDir)
  const toggle = (k: K) => { if (k === by) setDir((d) => (d === "asc" ? "desc" : "asc")); else { setBy(k); setDir("asc") } }
  return {
    by, dir, toggle,
    set: (k: K, d?: SortDir) => { setBy(k); setDir(d ?? dir) },
    /** Spread into <SortHeader {...sort.header("title")} label="Title" />. */
    header: (k: K) => ({ active: by === k, dir: by === k ? dir : ("asc" as SortDir), onSort: () => toggle(k) }),
  }
}

/** The view tabs above a Shopify index table ("All", "Active", "Draft"…), with room for search on the right. */
export function IndexTabs<T extends string>({ tabs, value, onChange, right }: {
  tabs: { id: T; label: React.ReactNode; count?: number }[]; value: T; onChange: (id: T) => void; right?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 border-b border-black/[0.08] px-2 py-1.5 dark:border-white/10">
      <div role="tablist" className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={value === t.id}
            onClick={() => onChange(t.id)}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/10",
              value === t.id && "bg-black/[0.08] text-foreground dark:bg-white/15",
            )}
          >
            {t.label}
            {t.count != null && <span className="tabular-nums text-xs text-muted-foreground">{t.count}</span>}
          </button>
        ))}
      </div>
      {right && <div className="flex shrink-0 items-center gap-1.5">{right}</div>}
    </div>
  )
}

/** Search box row for an index table, with filter pills underneath. */
export function IndexSearch({ value, onChange, placeholder = "Search", pills, onCancel, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder?: string; pills?: React.ReactNode; onCancel?: () => void; autoFocus?: boolean
}) {
  return (
    <div className="border-b border-black/[0.08] px-2 py-1.5 dark:border-white/10">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={value}
            autoFocus={autoFocus}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { if (value) onChange(""); else onCancel?.() } }}
            placeholder={placeholder}
            className="h-8 w-full rounded-lg border border-black/15 bg-background pl-8 pr-8 text-[13px] outline-none focus:border-foreground/40 focus:ring-2 focus:ring-ring/20 dark:border-white/15"
          />
          {value && (
            <button type="button" aria-label="Clear search" onClick={() => onChange("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>
          )}
        </div>
        {onCancel && <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>Cancel</Button>}
      </div>
      {pills && <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{pills}</div>}
    </div>
  )
}

/** A Shopify filter pill. Empty: dashed "Status +". Set: solid "Status: Active ×". Click opens `children` in a popover. */
export function FilterPill({ label, value, onClear, children }: { label: string; value?: React.ReactNode; onClear?: () => void; children: React.ReactNode }) {
  const set = value != null && value !== "" && value !== false
  return (
    <span className={cn("inline-flex h-7 items-center rounded-lg text-xs font-medium", set ? "bg-black/[0.08] dark:bg-white/15" : "border border-dashed border-black/25 dark:border-white/25")}>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="inline-flex h-full items-center gap-1 pl-2.5 pr-2">
            {set ? <>{label}: <span className="font-semibold">{value}</span></> : <>{label}<Plus className="size-3" /></>}
            {set && <ChevronDown className="size-3 opacity-60" />}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 p-2">{children}</PopoverContent>
      </Popover>
      {set && onClear && (
        <button type="button" aria-label={`Clear ${label}`} onClick={onClear} className="mr-1 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-black/10 hover:text-foreground dark:hover:bg-white/15"><X className="size-3" /></button>
      )}
    </span>
  )
}

/** Choice list for inside a FilterPill. */
export function FilterChoices<T extends string>({ options, value, onChange }: { options: { value: T; label: React.ReactNode }[]; value: T | null; onChange: (v: T | null) => void }) {
  return (
    <div className="space-y-0.5">
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent">
          <input type="radio" className="accent-foreground" checked={value === o.value} onChange={() => onChange(o.value)} />{o.label}
        </label>
      ))}
      {value != null && <button type="button" onClick={() => onChange(null)} className="mt-1 w-full rounded-md px-2 py-1 text-left text-xs text-tone-blue hover:underline">Clear</button>}
    </div>
  )
}

/** Ready-made index table: ticks, bulk bar, sortable headings and clickable rows, all in Shopify's look.
 *  For special layouts, build your own table with INDEX, useSelection, BulkBar and SortHeader instead. */
export type IndexColumn<T> = {
  key: string; label: React.ReactNode; render: (row: T) => React.ReactNode
  sortable?: boolean; align?: "left" | "right"; className?: string; hideBelow?: "sm" | "md" | "lg"
}
const HIDE: Record<string, string> = { sm: "hidden sm:table-cell", md: "hidden md:table-cell", lg: "hidden lg:table-cell" }
export function IndexTable<T>({ rows, rowId, columns, sel, sort, onSort, onRowClick, bulk, bulkMore, empty, total }: {
  rows: T[]; rowId: (row: T) => string; columns: IndexColumn<T>[]
  sel?: Selection
  sort?: { by: string; dir: SortDir }; onSort?: (key: string) => void
  onRowClick?: (row: T) => void
  bulk?: React.ReactNode; bulkMore?: HeaderAction[]
  empty?: React.ReactNode; total?: number
}) {
  if (rows.length === 0 && empty) return <>{empty}</>
  const bulkOn = !!sel && sel.count > 0
  return (
    <div className="overflow-x-auto">
      {sel && <BulkBar sel={sel} total={total} more={bulkMore}>{bulk}</BulkBar>}
      <table className={INDEX.table}>
        <thead className={cn(bulkOn && "sr-only")}>
          <tr>
            {sel && <th className={cn(INDEX.th, INDEX.check)}><SelectAllCheckbox sel={sel} /></th>}
            {columns.map((c) => {
              const cls = cn(c.className, c.hideBelow && HIDE[c.hideBelow])
              return c.sortable && onSort
                ? <SortHeader key={c.key} label={c.label} active={sort?.by === c.key} dir={sort?.by === c.key ? sort.dir : "asc"} onSort={() => onSort(c.key)} align={c.align} className={cls} />
                : <th key={c.key} className={cn(INDEX.th, c.align === "right" && "text-right", cls)}>{c.label}</th>
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const id = rowId(r)
            return (
              <tr key={id} data-selected={sel?.has(id) || undefined} className={cn(INDEX.tr, onRowClick && "cursor-pointer")} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                {sel && <td className={cn(INDEX.td, INDEX.check)} onClick={(e) => e.stopPropagation()}><RowCheckbox sel={sel} id={id} /></td>}
                {columns.map((c) => (
                  <td key={c.key} className={cn(INDEX.td, c.align === "right" && "text-right tabular-nums", c.className, c.hideBelow && HIDE[c.hideBelow])}>{c.render(r)}</td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
