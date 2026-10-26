// Website → Themes → Customize: Shopify-style theme editor. Sections on the left, the preview site on the right.
// Edits only ever change the Draft theme; the live website changes when the draft is published.
import { useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ArrowLeft, ChevronRight, ExternalLink, Eye, EyeOff, GripVertical, Loader2, Monitor, Plus, RefreshCw, Rocket, Smartphone, Trash2, ChevronUp, ChevronDown, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { MediaField } from "@/components/file-picker"
import { DRAFT_URL, LIVE_URL, PreviewBadge, usePreviewState } from "@/components/theme-ui"
import { useReorder } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  HEROMAP_DEFAULT, THEME_PAGES, TILE_DEFAULTS, formatHeroMap, formatTiles, getSettings, homeLayout, parseHeroMap, parseTiles,
  previewSrc, setHomeLayout, setSetting, type ThemeData, type ThemeField, type ThemeSection,
} from "@/lib/theme-schema"

export const Route = createFileRoute("/_app/website-theme-editor")({
  validateSearch: (s: Record<string, unknown>) => ({ id: String(s.id ?? ""), page: String(s.page ?? "home") }),
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

function Editor({ theme }: { theme: { _id: Id<"webThemes">; name: string; role: string; updatedAt: number; data: ThemeData } }) {
  const { page: pageId } = Route.useSearch()
  const navigate = useNavigate()
  const save = useMutation(api.themes.saveDraft)
  const publish = useMutation(api.themes.publish)
  const overview = useQuery(api.themes.overview)
  const colls = useQuery(api.website.collections)
  const collections: Coll[] = (colls?.collections ?? []) as Coll[]

  const [data, setData] = useState<ThemeData>(theme.data)
  const [base, setBase] = useState(() => JSON.stringify(theme.data))
  const [savedAt, setSavedAt] = useState(theme.updatedAt)
  const [saving, setSaving] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop")
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
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = "" } }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  // which page the preview shows
  const sampleColl = collections.find((c) => c.handle === "new-arrivals") ?? collections.find((c) => c.productHandles.length > 0)
  const path = page.id === "home" ? "/" : page.id === "product" ? (sampleColl?.productHandles[0] ? `/products/${sampleColl.productHandles[0]}` : "/") : page.id === "collection" ? `/collections/${sampleColl?.handle ?? "all"}` : page.path
  const src = `${hook ? DRAFT_URL : LIVE_URL}${path}`

  const doSave = async () => {
    if (!editable) return
    setSaving(true)
    try {
      const json = JSON.stringify(data)
      const r = await save({ id: theme._id, data: json, updatedAt: savedAt })
      setBase(json)
      setSavedAt(r.updatedAt)
      toast.success(hook ? "Saved — the preview updates in 1–3 minutes" : "Saved")
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }

  const set = (s: ThemeSection, key: string, value: any) => setData((d) => setSetting(d, s.template, s.section, key, value))

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-canvas">
      {/* top bar */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-3">
        <Button variant="ghost" size="sm" onClick={() => { if (dirty && !confirm("Leave without saving your changes?")) return; navigate({ to: "/website-themes" }) }}>
          <ArrowLeft className="size-4" /> <span className="hidden sm:inline">Themes</span>
        </Button>
        <div className="hidden min-w-0 items-center gap-2 md:flex">
          <span className="truncate text-sm font-semibold">{theme.name}</span>
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", editable ? "bg-tone-blue/15 text-tone-blue" : "bg-muted text-muted-foreground")}>{editable ? "Draft" : theme.role === "live" ? "Live" : "Archived"}</span>
        </div>
        <select value={page.id} onChange={(e) => { setSel(null); navigate({ to: "/website-theme-editor", search: { id: theme._id, page: e.target.value }, replace: true }) }}
          className="mx-auto h-9 rounded-md border bg-background px-2 text-sm font-medium">
          {THEME_PAGES.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
        <div className="hidden rounded-md border p-0.5 sm:flex">
          <button type="button" aria-label="Computer" onClick={() => setDevice("desktop")} className={cn("rounded p-1.5", device === "desktop" ? "bg-muted" : "text-muted-foreground")}><Monitor className="size-4" /></button>
          <button type="button" aria-label="Phone" onClick={() => setDevice("mobile")} className={cn("rounded p-1.5", device === "mobile" ? "bg-muted" : "text-muted-foreground")}><Smartphone className="size-4" /></button>
        </div>
        <div className="hidden lg:block"><PreviewBadge state={preview.state} hook={hook} /></div>
        <Button variant="ghost" size="icon" aria-label="Reload preview" onClick={() => { setFrameKey((k) => k + 1); preview.recheck() }}><RefreshCw className="size-4" /></Button>
        <Button variant="ghost" size="icon" aria-label="Open preview" asChild><a href={src} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /></a></Button>
        {editable && <Button size="sm" variant="outline" disabled={dirty || saving} onClick={() => setAskPublish(true)} title={dirty ? "Save first" : undefined}><Rocket className="size-4" /> <span className="hidden sm:inline">Publish</span></Button>}
        {editable && <Button size="sm" disabled={!dirty || saving} onClick={doSave}>{saving && <Loader2 className="size-4 animate-spin" />} Save</Button>}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* left: sections / fields */}
        <aside className="flex w-full max-w-[360px] shrink-0 flex-col border-r bg-card">
          {!editable && <p className="m-3 rounded-md bg-tone-amber/10 px-3 py-2 text-xs text-tone-amber">Only the draft theme can be changed. Go back and use “Edit a copy”.</p>}
          {section ? (
            <SectionFields section={section} data={data} collections={collections} disabled={!editable} onBack={() => setSel(null)} onChange={(k, v) => set(section, k, v)} />
          ) : (
            <SectionList page={page} data={data} disabled={!editable} onOpen={setSel} onLayout={(l) => setData((d) => setHomeLayout(d, l))} />
          )}
        </aside>

        {/* right: preview */}
        <main className="relative hidden min-w-0 flex-1 overflow-auto bg-muted/60 md:block">
          {!hook && (
            <div className="sticky top-0 z-10 border-b bg-tone-amber/10 px-4 py-2 text-xs text-tone-amber">
              Showing the live website — the preview site isn’t connected yet, so saved changes won’t appear here until you publish.
            </div>
          )}
          <div className={cn("mx-auto h-full p-4", device === "mobile" ? "w-[420px]" : "w-full")}>
            <iframe key={frameKey} src={`${src}${src.includes("?") ? "&" : "?"}v=${frameKey}`} title="Preview"
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

// ------------------------------------------------------------------ section list
function SectionList({ page, data, disabled, onOpen, onLayout }: {
  page: (typeof THEME_PAGES)[number]; data: ThemeData; disabled: boolean; onOpen: (id: string) => void; onLayout: (l: { id: string; hidden: boolean }[]) => void
}) {
  const isHome = page.id === "home"
  const layout = isHome ? homeLayout(data) : page.sections.map((s) => ({ id: s.id, hidden: false }))
  const { props, drag, over, move } = useReorder(layout, (n) => !disabled && onLayout(n))
  const byId = new Map(page.sections.map((s) => [s.id, s]))
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{page.title}</h2>
        <p className="text-xs text-muted-foreground">{page.note ?? (isHome ? "Click a section to change it. Drag to reorder, use the eye to hide." : "Click a section to change it.")}</p>
      </div>
      <ul className="p-2">
        {layout.map((row, i) => {
          const s = byId.get(row.id)!
          return (
            <li key={row.id} {...(isHome && !disabled ? props(i) : {})}
              className={cn("group flex items-center gap-1 rounded-md pr-1 hover:bg-muted", drag === i && "opacity-40", over === i && drag !== null && drag !== i && "ring-1 ring-foreground/40", row.hidden && "text-muted-foreground")}>
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

// ------------------------------------------------------------------ section fields
function SectionFields({ section, data, collections, disabled, onBack, onChange }: {
  section: ThemeSection; data: ThemeData; collections: Coll[]; disabled: boolean; onBack: () => void; onChange: (key: string, v: any) => void
}) {
  const values = getSettings(data, section.template, section.section)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-2">
        <Button variant="ghost" size="icon" className="size-8" onClick={onBack} aria-label="Back"><ArrowLeft className="size-4" /></Button>
        <h2 className="truncate text-sm font-semibold">{section.title}</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {section.help && <p className="text-xs text-muted-foreground">{section.help}</p>}
        {!section.fields.length && <p className="rounded-md bg-muted px-3 py-3 text-sm text-muted-foreground">This section has no settings. You can move or hide it from the section list.</p>}
        <fieldset disabled={disabled} className="space-y-4">
          {section.fields.map((f) => <FieldInput key={f.id} field={f} value={values[f.id]} collections={collections} onChange={(v) => onChange(f.id, v)} />)}
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
      {allowEmpty && <option value="">{placeholder ? `Default (${placeholder})` : "Choose a collection"}</option>}
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
