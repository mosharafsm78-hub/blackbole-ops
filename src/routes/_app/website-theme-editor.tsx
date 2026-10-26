// Website → Themes → Customize: Shopify-style theme editor. Sections on the left, the preview site on the right.
// Edits only ever change the Draft theme; the live website changes when the draft is published.
//  - every change shows in the preview at once (the website's public/js/bb-editor.js applies it by postMessage)
//  - undo / redo (⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z or ⌘/Ctrl+Y), save (⌘/Ctrl+S), also while the preview has the keyboard
//  - pick which product or collection the preview shows; Theme settings for the site's colours
//  - hovering a section in the list outlines it in the preview and the other way round; the inspector can be switched off
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link, createFileRoute, useBlocker, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import {
  ArrowLeft, Check, ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown, ExternalLink, Eye, EyeOff, GripVertical, LayoutList, Loader2, Monitor,
  MousePointerClick, Palette, Plus, Redo2, RefreshCw, Rocket, RotateCcw, Smartphone, Trash2, Undo2, X,
} from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { MediaField } from "@/components/file-picker"
import { DRAFT_URL, LIVE_URL, PreviewStatus, usePreviewState } from "@/components/theme-ui"
import { useReorder } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  HEROMAP_DEFAULT, THEME_PAGES, THEME_SETTINGS, TILE_DEFAULTS, formatHeroMap, formatTiles, getGlobals, getSettings, historyInit, historyPush,
  historyRedo, historyUndo, homeLayout, isHexColor, parseHeroMap, parseTiles, previewMessage, previewSrc, setGlobal, setHomeLayout, setSetting,
  type ThemeData, type ThemeField, type ThemeSection,
} from "@/lib/theme-schema"

export const Route = createFileRoute("/_app/website-theme-editor")({
  validateSearch: (s: Record<string, unknown>): { id: string; page: string; handle?: string } => ({
    id: String(s.id ?? ""), page: String(s.page ?? "home"), ...(s.handle ? { handle: String(s.handle) } : {}),
  }),
  component: () => <WebsiteGuard><Load /></WebsiteGuard>,
})

function Load() {
  const { id } = Route.useSearch()
  const theme = useQuery(api.themes.get, id ? { id: id as Id<"webThemes"> } : "skip")
  const navigate = useNavigate()
  if (!id) { navigate({ to: "/website-themes" }); return null }
  if (theme === undefined) return <Loading />
  if (theme === null) return <div className="p-10 text-center text-sm text-muted-foreground">This theme was deleted.</div>
  return <Editor key={theme._id} theme={theme} />
}

type Coll = { handle: string; title: string; productHandles: string[] }
type Pick = { handle: string; title: string; image?: string | null }
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const KEY = IS_MAC ? "⌘" : "Ctrl+"

function Editor({ theme }: { theme: { _id: Id<"webThemes">; name: string; role: string; updatedAt: number; data: ThemeData } }) {
  const { page: pageId, handle: pickedHandle } = Route.useSearch()
  const navigate = useNavigate()
  const save = useMutation(api.themes.saveDraft)
  const publish = useMutation(api.themes.publish)
  const rebuildPreview = useMutation(api.themes.rebuildPreview)
  const overview = useQuery(api.themes.overview)
  const colls = useQuery(api.website.collections)
  const collections: Coll[] = (colls?.collections ?? []) as Coll[]

  // ---- the theme being edited, with undo / redo
  const [hist, setHist] = useState(() => historyInit<ThemeData>(theme.data))
  const data = hist.present
  const change = (fn: (d: ThemeData) => ThemeData, group: string | null = null) => setHist((h) => historyPush(h, fn(h.present), group))
  const undo = () => setHist(historyUndo)
  const redo = () => setHist(historyRedo)

  const [base, setBase] = useState(() => JSON.stringify(theme.data))
  const [savedAt, setSavedAt] = useState(theme.updatedAt)
  const [saving, setSaving] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [panel, setPanel] = useState<"sections" | "settings">("sections")
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop")
  const [inspector, setInspector] = useState(true)
  const [hover, setHover] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  const [askPublish, setAskPublish] = useState(false)
  const dirty = useMemo(() => JSON.stringify(data) !== base, [data, base])
  const editable = theme.role === "draft"
  const hook = !!overview?.draftHook
  const preview = usePreviewState(savedAt, hook)

  const page = THEME_PAGES.find((p) => p.id === pageId) ?? THEME_PAGES[0]
  const section = page.sections.find((s) => s.id === sel) ?? null

  // reload the preview once the preview site has the latest save
  const lastState = useRef(preview.state)
  useEffect(() => { if (preview.state === "ready" && lastState.current === "updating") setFrameKey((k) => k + 1); lastState.current = preview.state }, [preview.state])

  // leaving with unsaved changes asks first (switching pages inside the editor keeps them)
  useBlocker({
    shouldBlockFn: ({ next }) => dirty && next.pathname !== "/website-theme-editor" && !window.confirm("You have unsaved theme changes. Leave the editor and lose them?"),
    enableBeforeUnload: () => dirty,
  })

  // ---- which page the preview shows: for product and collection pages, the one picked in the top bar
  const products = useQuery(api.website.products, page.id === "product" ? {} : "skip")
  const productPicks: Pick[] = useMemo(() => (products ?? []).filter((p) => p.handle && p.published).map((p) => ({ handle: p.handle as string, title: p.title, image: p.image })), [products])
  const collectionPicks: Pick[] = useMemo(() => collections.filter((c) => !c.handle.startsWith("pre-order")).map((c) => ({ handle: c.handle, title: c.title })), [collections])
  const sampleColl = collections.find((c) => c.handle === "new-arrivals") ?? collections.find((c) => c.productHandles.length > 0)
  const handle = page.id === "product" ? pickedHandle || sampleColl?.productHandles[0] || productPicks[0]?.handle || ""
    : page.id === "collection" ? pickedHandle || sampleColl?.handle || "all" : ""
  const path = page.id === "home" ? "/" : page.id === "product" ? (handle ? `/products/${handle}` : "/") : page.id === "collection" ? `/collections/${handle}` : page.path
  const src = `${hook ? DRAFT_URL : LIVE_URL}${path}`
  const frameOrigin = new URL(src).origin
  const goPage = (id: string, h?: string) => {
    if (id !== page.id) setSel(null)
    navigate({ to: "/website-theme-editor", search: { id: theme._id, page: id, ...(h ? { handle: h } : {}) }, replace: true })
  }

  // ---- live preview: every change goes to the page in the frame at once; a click on a section there opens it here.
  // Nothing in the frame can be bought or opened.
  const frame = useRef<HTMLIFrameElement>(null)
  const scrollNext = useRef(false)
  const message = useMemo(() => previewMessage(page, data, sel, inspector), [page, data, sel, inspector])
  const post = (m: object) => frame.current?.contentWindow?.postMessage(m, frameOrigin)
  const sendNow = (scroll = false) => post({ ...message, scroll })
  useEffect(() => { sendNow(scrollNext.current); scrollNext.current = false }, [message]) // eslint-disable-line react-hooks/exhaustive-deps
  const hoverRow = (id: string | null) => post({ type: "bb:hover", id })

  const doSave = async () => {
    if (!editable || !dirty || saving) return
    setSaving(true)
    try {
      const json = JSON.stringify(data)
      const r = await save({ id: theme._id, data: json, updatedAt: savedAt })
      setBase(json)
      setSavedAt(r.updatedAt)
      toast.success(hook ? "Saved — the preview site updates in 1–3 minutes" : "Saved")
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }

  // ---- keyboard: undo, redo, save (here, and forwarded by the preview page)
  const keys = useRef<(k: string, shift: boolean) => boolean>(() => false)
  keys.current = (k, shift) => {
    if (k === "s") { void doSave(); return true }
    if (!editable) return false
    if (k === "z") { if (shift) redo(); else undo(); return true }
    if (k === "y") { redo(); return true }
    return false
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      if (keys.current(e.key.toLowerCase(), e.shiftKey)) e.preventDefault()
    }
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [])

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== frameOrigin || !e.data || typeof e.data !== "object") return
      const m = e.data
      if (m.type === "bb:ready") sendNow(!!sel)
      if (m.type === "bb:select" && page.sections.some((x) => x.id === m.id)) { setPanel("sections"); setSel(String(m.id)) }
      if (m.type === "bb:hover") setHover(m.id ? String(m.id) : null)
      if (m.type === "bb:key") keys.current(String(m.key), !!m.shift)
    }
    window.addEventListener("message", on)
    return () => window.removeEventListener("message", on)
  })
  const openSection = (id: string | null) => { scrollNext.current = true; setSel(id) }

  const set = (s: ThemeSection, key: string, value: any) => change((d) => setSetting(d, s.template, s.section, key, value), `${s.template}/${s.section}/${key}`)
  const rebuild = async () => { try { await rebuildPreview({}); toast.success("Preview site is rebuilding"); setTimeout(preview.recheck, 2000) } catch (e) { toast.error(errMsg(e)) } }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-canvas">
      {/* top bar */}
      <header className="flex h-14 shrink-0 items-center gap-1.5 border-b bg-card px-3">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/website-themes" })}>
          <ArrowLeft className="size-4" /> <span className="hidden sm:inline">Themes</span>
        </Button>
        <div className="hidden min-w-0 items-center gap-2 xl:flex">
          <span className="max-w-48 truncate text-sm font-semibold">{theme.name}</span>
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", editable ? "bg-tone-blue/15 text-tone-blue" : "bg-muted text-muted-foreground")}>{editable ? "Draft" : theme.role === "live" ? "Live" : "Archived"}</span>
        </div>
        <div className="mx-auto flex min-w-0 items-center gap-1.5">
          <select value={page.id} onChange={(e) => goPage(e.target.value)} aria-label="Page" className="h-9 rounded-md border bg-background px-2 text-sm font-medium">
            {THEME_PAGES.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
          {page.id === "product" && <PreviewPicker label="Product" items={productPicks} value={handle} loading={products === undefined} onPick={(h) => goPage(page.id, h)} />}
          {page.id === "collection" && <PreviewPicker label="Collection" items={collectionPicks} value={handle} loading={colls === undefined} onPick={(h) => goPage(page.id, h)} />}
        </div>
        <div className="hidden rounded-md border p-0.5 sm:flex">
          <button type="button" aria-label="Computer" title="Computer" onClick={() => setDevice("desktop")} className={cn("rounded p-1.5", device === "desktop" ? "bg-muted" : "text-muted-foreground")}><Monitor className="size-4" /></button>
          <button type="button" aria-label="Phone" title="Phone" onClick={() => setDevice("mobile")} className={cn("rounded p-1.5", device === "mobile" ? "bg-muted" : "text-muted-foreground")}><Smartphone className="size-4" /></button>
        </div>
        <button type="button" aria-pressed={inspector} onClick={() => setInspector((v) => !v)}
          title={inspector ? "Inspector on: hover and click sections in the preview to edit them" : "Inspector off: the preview ignores the mouse"}
          className={cn("hidden rounded-md border p-2 sm:block", inspector ? "bg-tone-blue/10 text-tone-blue" : "text-muted-foreground")}><MousePointerClick className="size-4" /></button>
        {editable && (
          <div className="hidden items-center md:flex">
            <Button variant="ghost" size="icon" aria-label="Undo" title={`Undo (${KEY}Z)`} disabled={!hist.past.length} onClick={undo}><Undo2 className="size-4" /></Button>
            <Button variant="ghost" size="icon" aria-label="Redo" title={`Redo (${KEY}Shift+Z)`} disabled={!hist.future.length} onClick={redo}><Redo2 className="size-4" /></Button>
          </div>
        )}
        <div className="hidden lg:block"><PreviewStatus hook={hook} state={preview.state} builtAt={preview.builtAt} build={overview?.draftBuild} last={overview?.draftLastBuild} onRebuild={rebuild} /></div>
        <Button variant="ghost" size="icon" aria-label="Reload preview" title="Reload preview" onClick={() => { setFrameKey((k) => k + 1); preview.recheck() }}><RefreshCw className="size-4" /></Button>
        <Button variant="ghost" size="icon" aria-label="Open preview" title="Open the preview site in a new tab" asChild><a href={src} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /></a></Button>
        {editable && <Button size="sm" variant="outline" disabled={dirty || saving} onClick={() => setAskPublish(true)} title={dirty ? "Save first" : undefined}><Rocket className="size-4" /> <span className="hidden sm:inline">Publish</span></Button>}
        {editable && dirty && <Button size="sm" variant="ghost" disabled={saving} onClick={() => change(() => JSON.parse(base))} title="Undo all unsaved changes (you can redo them)">Discard</Button>}
        {editable && <Button size="sm" disabled={!dirty || saving} onClick={doSave} title={`Save (${KEY}S)`}>{saving && <Loader2 className="size-4 animate-spin" />} Save</Button>}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* left: sections / fields / theme settings */}
        <aside className="flex w-full max-w-[360px] shrink-0 flex-col border-r bg-card">
          <div className="flex shrink-0 gap-1 border-b p-1.5">
            <TabButton active={panel === "sections"} onClick={() => setPanel("sections")}><LayoutList className="size-4" /> Sections</TabButton>
            <TabButton active={panel === "settings"} onClick={() => setPanel("settings")}><Palette className="size-4" /> Theme settings</TabButton>
          </div>
          {!editable && <p className="m-3 rounded-md bg-tone-amber/10 px-3 py-2 text-xs text-tone-amber">Only the draft theme can be changed. Go back and use “Edit a copy”.</p>}
          {panel === "settings" ? (
            <ThemeSettingsPanel data={data} disabled={!editable} onChange={(k, v) => change((d) => setGlobal(d, k, v), `settings/${k}`)} />
          ) : section ? (
            <SectionFields section={section} data={data} collections={collections} disabled={!editable} hook={hook} onBack={() => setSel(null)} onChange={(k, v) => set(section, k, v)} />
          ) : (
            <SectionList page={page} data={data} disabled={!editable} hover={hover} onHover={hoverRow} onOpen={openSection} onLayout={(l) => change((d) => setHomeLayout(d, l))} />
          )}
        </aside>

        {/* right: preview */}
        <main className="relative hidden min-w-0 flex-1 flex-col bg-muted/60 md:flex">
          <div className="z-10 shrink-0 border-b bg-card/95 px-4 py-2 text-xs text-muted-foreground backdrop-blur">
            Changes show here as you make them{inspector ? " — click any part of the page to edit it" : ""}. Links and buttons don’t work in the editor.
            {dirty ? " Save to keep your changes." : ""}
          </div>
          <div className={cn("mx-auto min-h-0 w-full flex-1 p-4", device === "mobile" && "w-[420px]")}>
            <iframe ref={frame} key={frameKey} src={`${src}${src.includes("?") ? "&" : "?"}bb_editor=1&v=${frameKey}`} title="Preview"
              onMouseLeave={() => setHover(null)}
              className={cn("h-full w-full rounded-lg border bg-white shadow-sm", device === "mobile" && "rounded-[28px] border-8 border-foreground/80")} />
          </div>
        </main>
      </div>

      <Dialog open={askPublish} onOpenChange={setAskPublish}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish “{theme.name}”?</DialogTitle>
            <DialogDescription>The draft becomes the live website in about a minute. The current live theme is kept in the theme library — one click on Roll back brings it back.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAskPublish(false)}>Cancel</Button>
            <Button onClick={async () => {
              try { await publish({ id: theme._id }); toast.success("Published — live in about a minute"); navigate({ to: "/website-themes" }) } catch (e) { toast.error(errMsg(e)) }
            }}><Rocket className="size-4" /> Publish</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium", active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")}>
      {children}
    </button>
  )
}

// ------------------------------------------------------------------ which product / collection the preview shows
function PreviewPicker({ label, items, value, loading, onPick }: { label: string; items: Pick[]; value: string; loading: boolean; onPick: (handle: string) => void }) {
  const [open, setOpen] = useState(false)
  const cur = items.find((i) => i.handle === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" title={`Which ${label.toLowerCase()} the preview shows`}
          className="flex h-9 min-w-0 max-w-56 items-center gap-1.5 rounded-md border bg-background px-2 text-sm">
          <span className="text-muted-foreground">{label}:</span>
          <span className="truncate font-medium">{cur?.title ?? (value || "…")}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="center">
        <Command>
          <CommandInput placeholder={`Search ${label.toLowerCase()}s`} />
          <CommandList>
            <CommandEmpty>{loading ? "Loading…" : `No ${label.toLowerCase()} found.`}</CommandEmpty>
            {items.map((i) => (
              <CommandItem key={i.handle} value={`${i.title} ${i.handle}`} onSelect={() => { onPick(i.handle); setOpen(false) }}>
                {i.image ? <img src={i.image} alt="" className="size-7 shrink-0 rounded object-cover" /> : null}
                <span className="truncate">{i.title}</span>
                {i.handle === value && <Check className="ml-auto size-4 shrink-0" />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ------------------------------------------------------------------ section list
function SectionList({ page, data, disabled, hover, onHover, onOpen, onLayout }: {
  page: (typeof THEME_PAGES)[number]; data: ThemeData; disabled: boolean; hover: string | null; onHover: (id: string | null) => void
  onOpen: (id: string) => void; onLayout: (l: { id: string; hidden: boolean }[]) => void
}) {
  const isHome = page.id === "home"
  const layout = isHome ? homeLayout(data) : page.sections.map((s) => ({ id: s.id, hidden: false }))
  const { props, drag, over, move } = useReorder(layout, (n) => !disabled && onLayout(n))
  const byId = new Map(page.sections.map((s) => [s.id, s]))
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" onMouseLeave={() => onHover(null)}>
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{page.title}</h2>
        <p className="text-xs text-muted-foreground">{page.note ?? (isHome ? "Click a section to change it. Drag to reorder, use the eye to hide." : "Click a section to change it.")}</p>
      </div>
      <ul className="p-2">
        {layout.map((row, i) => {
          const s = byId.get(row.id)!
          return (
            <li key={row.id} {...(isHome && !disabled ? props(i) : {})} onMouseEnter={() => onHover(row.id)}
              className={cn("group flex items-center gap-1 rounded-md pr-1 hover:bg-muted", hover === row.id && "bg-muted ring-1 ring-tone-blue/50", drag === i && "opacity-40", over === i && drag !== null && drag !== i && "ring-1 ring-foreground/40", row.hidden && "text-muted-foreground")}>
              {isHome && <GripVertical className={cn("size-4 shrink-0 text-muted-foreground/60", !disabled && "cursor-grab")} />}
              <button type="button" onClick={() => onOpen(row.id)} className={cn("flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-sm", !isHome && "pl-2")}>
                <span className={cn("truncate", row.hidden && "line-through")}>{s.title}</span>
                {!s.fields.length && <span className="text-[11px] text-muted-foreground">no settings</span>}
              </button>
              {isHome && !disabled && (
                <>
                  <button type="button" aria-label="Move up" onClick={() => move(i, i - 1)} className="rounded p-1 text-muted-foreground opacity-0 hover:bg-background group-hover:opacity-100"><ChevronUp className="size-3.5" /></button>
                  <button type="button" aria-label="Move down" onClick={() => move(i, i + 1)} className="rounded p-1 text-muted-foreground opacity-0 hover:bg-background group-hover:opacity-100"><ChevronDown className="size-3.5" /></button>
                  <button type="button" aria-label={row.hidden ? "Show" : "Hide"} title={row.hidden ? "Show this section" : "Hide this section"}
                    onClick={() => onLayout(layout.map((x, j) => (j === i ? { ...x, hidden: !x.hidden } : x)))}
                    className={cn("rounded p-1 hover:bg-background", row.hidden ? "text-foreground" : "text-muted-foreground opacity-0 group-hover:opacity-100")}>
                    {row.hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </>
              )}
              <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
            </li>
          )
        })}
      </ul>
      {isHome && !disabled && (
        <div className="px-4 pb-4">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => onLayout(page.sections.map((s) => ({ id: s.id, hidden: false })))}>
            <RotateCcw className="size-3.5" /> Reset order and show all
          </Button>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ theme settings (global)
function ThemeSettingsPanel({ data, disabled, onChange }: { data: ThemeData; disabled: boolean; onChange: (key: string, v: string | null) => void }) {
  const g = getGlobals(data)
  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
      <fieldset disabled={disabled} className="space-y-6">
        {THEME_SETTINGS.map((grp) => (
          <section key={grp.id}>
            <h2 className="text-sm font-semibold">{grp.title}</h2>
            {grp.help && <p className="mb-3 text-xs text-muted-foreground">{grp.help}</p>}
            <div className="space-y-3">
              {grp.fields.map((f) => <ColorInput key={f.id} field={f} value={g[f.id] == null ? "" : String(g[f.id])} onChange={(v) => onChange(f.id, v)} />)}
            </div>
          </section>
        ))}
      </fieldset>
      <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        The logo, favicon and fonts are part of the website’s design. The announcement bar, contact details and social links are in{" "}
        <Link to="/website-settings" className="underline">Website → Settings</Link>.
      </p>
    </div>
  )
}

const fullHex = (v: string) => (/^#[0-9a-f]{3}$/i.test(v) ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : /^#[0-9a-f]{6}/i.test(v) ? v.slice(0, 7) : "")

function ColorInput({ field, value, onChange }: { field: ThemeField; value: string; onChange: (v: string | null) => void }) {
  const shown = isHexColor(value) ? value.trim() : field.placeholder ?? "#000000"
  const bad = value.trim() !== "" && !isHexColor(value)
  return (
    <div>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={field.label} value={fullHex(shown) || "#000000"} onChange={(e) => onChange(e.target.value)}
          className="size-8 shrink-0 cursor-pointer rounded border bg-background p-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{field.label}</div>
          {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
        </div>
        <Input className="h-8 w-24 font-mono text-xs" value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} aria-label={`${field.label} (hex)`} />
        <Button type="button" variant="ghost" size="icon" className={cn("size-7", !value && "invisible")} aria-label="Use the built-in colour" title="Use the built-in colour" onClick={() => onChange(null)}><X className="size-3.5" /></Button>
      </div>
      {bad && <p className="mt-1 text-xs text-tone-red">Use a colour code like #1C1915. The website ignores anything else.</p>}
    </div>
  )
}

// ------------------------------------------------------------------ section fields
function SectionFields({ section, data, collections, disabled, hook, onBack, onChange }: {
  section: ThemeSection; data: ThemeData; collections: Coll[]; disabled: boolean; hook: boolean; onBack: () => void; onChange: (key: string, v: any) => void
}) {
  const values = getSettings(data, section.template, section.section)
  const later = hook ? "Shows in the preview after you save (the preview site rebuilds in 1–3 minutes)." : "Shows on the website after you save and publish."
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-2">
        <Button variant="ghost" size="icon" className="size-8" onClick={onBack} aria-label="Back"><ArrowLeft className="size-4" /></Button>
        <h2 className="truncate text-sm font-semibold">{section.title}</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {section.help && <p className="text-xs text-muted-foreground">{section.help}</p>}
        {section.live === false && section.fields.length > 0 && <p className="rounded-md bg-tone-amber/10 px-3 py-2 text-xs text-tone-amber">{later}</p>}
        {!section.fields.length && <p className="rounded-md bg-muted px-3 py-3 text-sm text-muted-foreground">This section has no settings. You can move or hide it from the section list.</p>}
        <fieldset disabled={disabled} className="space-y-4">
          {section.fields.map((f) => (
            <div key={f.id}>
              <FieldInput field={f} value={values[f.id]} collections={collections} onChange={(v) => onChange(f.id, v)} />
              {f.live === false && section.live !== false && <p className="mt-1 text-xs text-tone-amber">{later}</p>}
            </div>
          ))}
        </fieldset>
      </div>
    </div>
  )
}

function Label({ field }: { field: ThemeField }) {
  return <div className="mb-1.5 text-sm font-medium">{field.label}</div>
}
function Help({ field }: { field: ThemeField }) {
  return field.help ? <p className="mt-1 text-xs text-muted-foreground">{field.help}</p> : null
}

function CollectionSelect({ value, onChange, collections, placeholder, allowEmpty = true }: { value: string; onChange: (v: string) => void; collections: Coll[]; placeholder?: string; allowEmpty?: boolean }) {
  const known = collections.some((c) => c.handle === value)
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
      {allowEmpty && <option value="">{placeholder ? `Default (${placeholder})` : "None"}</option>}
      {value && !known && <option value={value}>{value}</option>}
      {collections.map((c) => <option key={c.handle} value={c.handle}>{c.title}</option>)}
    </select>
  )
}

function FieldInput({ field, value, collections, onChange }: { field: ThemeField; value: any; collections: Coll[]; onChange: (v: any) => void }) {
  const str = value == null ? "" : String(value)
  switch (field.type) {
    case "image": case "video":
      return (
        <div>
          <Label field={field} />
          <MediaField kind={field.type} value={str} onChange={onChange} fallback={field.def ? `${LIVE_URL}/assets/files/${field.def}` : undefined} />
          <Help field={field} />
        </div>
      )
    case "textarea":
      return <div><Label field={field} /><Textarea rows={3} value={str} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} /><Help field={field} /></div>
    case "number":
      return <div><Label field={field} /><Input type="number" min={field.min} max={field.max} value={str} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} /><Help field={field} /></div>
    case "collection":
      return <div><Label field={field} /><CollectionSelect value={str} onChange={onChange} collections={collections} placeholder={field.placeholder} /><Help field={field} /></div>
    case "url":
      return (
        <div>
          <Label field={field} />
          <Input value={str} placeholder={field.placeholder} list="theme-links" onChange={(e) => onChange(e.target.value)} />
          <datalist id="theme-links">{collections.map((c) => <option key={c.handle} value={`/collections/${c.handle}`}>{c.title}</option>)}</datalist>
          <Help field={field} />
        </div>
      )
    case "tiles":
      return <TilesInput field={field} value={str} collections={collections} onChange={onChange} />
    case "heromap":
      return <HeroMapInput field={field} value={str} collections={collections} onChange={onChange} />
    case "color":
      return <ColorInput field={field} value={str} onChange={onChange} />
    default:
      return <div><Label field={field} /><Input value={str} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} /><Help field={field} /></div>
  }
}

function TilesInput({ field, value, collections, onChange }: { field: ThemeField; value: string; collections: Coll[]; onChange: (v: string | null) => void }) {
  const def = TILE_DEFAULTS[field.id] ?? ""
  const rows = parseTiles(value || def)
  const put = (n: { handle: string; label: string }[]) => onChange(formatTiles(n) || null)
  return (
    <div>
      <Label field={field} />
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className="w-1/2"><CollectionSelect value={r.handle} allowEmpty={false} collections={collections} onChange={(h) => put(rows.map((x, j) => (j === i ? { ...x, handle: h } : x)))} /></div>
            <Input className="h-9 flex-1" value={r.label} placeholder="Name" onChange={(e) => put(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label="Remove" onClick={() => put(rows.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-2">
        {rows.length < 6 && collections[0] && <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => put([...rows, { handle: collections[0].handle, label: collections[0].title }])}><Plus className="size-3.5" /> Add tile</Button>}
        {value && <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => onChange(null)}><RotateCcw className="size-3.5" /> Default</Button>}
      </div>
      <Help field={field} />
    </div>
  )
}

function HeroMapInput({ field, value, collections, onChange }: { field: ThemeField; value: string; collections: Coll[]; onChange: (v: string | null) => void }) {
  const rows = parseHeroMap(value || HEROMAP_DEFAULT)
  const put = (n: { handle: string; files: string[] }[]) => onChange(formatHeroMap(n) || null)
  return (
    <div>
      <Label field={field} />
      <Help field={field} />
      <div className="mt-2 space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="space-y-1.5 rounded-lg border p-2">
            <div className="flex items-center gap-1.5">
              <div className="flex-1"><CollectionSelect value={r.handle} allowEmpty={false} collections={collections} onChange={(h) => put(rows.map((x, j) => (j === i ? { ...x, handle: h } : x)))} /></div>
              <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="Remove" onClick={() => put(rows.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
            </div>
            {[0, 1].map((k) => (
              <MediaField key={k} kind="image" value={/^https?:/.test(r.files[k] ?? "") ? r.files[k] : ""} fallback={r.files[k] && !/^https?:/.test(r.files[k]) ? previewSrc(r.files[k], LIVE_URL) : undefined}
                onChange={(u) => { const files = [...r.files]; files[k] = u; put(rows.map((x, j) => (j === i ? { ...x, files: files.filter((f, n) => n === 0 || f) } : x))) }} />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        {collections[0] && <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => put([...rows, { handle: collections[0].handle, files: [] }])}><Plus className="size-3.5" /> Add collection</Button>}
        {value && <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => onChange(null)}><RotateCcw className="size-3.5" /> Default</Button>}
      </div>
    </div>
  )
}
