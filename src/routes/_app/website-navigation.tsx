// Website → Menus (Shopify: Content → Menus): the website's menus with Shopify's menu editor (drag to reorder and
// nest up to three levels, link picker for collections, products, pages, blogs, blog posts or any web address),
// plus URL redirects (search, tick to delete, import / export CSV in Shopify's format).
import { useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ArrowRight, ChevronDown, ChevronRight, CornerDownRight, Download, GripVertical, IndentDecrease, IndentIncrease, Link2, ListTree, Pencil, Plus, Search, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { EmptyImport, ImportButton } from "@/components/content-ui"
import { WebsiteTabs } from "@/components/discount-ui"
import { Card, Field, IndexSearch, IndexTable, PageHeader, SaveBar, Section, useDirty, useSelection } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { parseCsv } from "@/lib/csv"
import { errMsg } from "@/lib/format"
import {
  MAX_DEPTH, addChild, blockEnd, blockSpan, build, countItems, depthRange, flatten, moveBlock, removeBlock, redirectsFromCsv, redirectsToCsv, shiftBlock,
  type MenuItem, type Row,
} from "@/lib/menu-tree"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/website-navigation")({
  component: () => <WebsiteGuard><TooltipProvider delayDuration={200}><Navigation /></TooltipProvider></WebsiteGuard>,
})

type Menu = { _id: Id<"webMenus">; handle: string; title: string; items: MenuItem[] }

/** Menus the website's header actually uses (by handle), with plain names. Others are kept but not shown. */
const USED: Record<string, string> = {
  "bb2-main": "Main menu (top of every page)",
  "bb2-drawer": "Mobile menu",
  "bb2-mega-men": "Big menu · Men column",
  "bb2-mega-women": "Big menu · Women column",
  "bb2-mega-acc": "Big menu · Accessories & kids column",
  "bb2-mega-shopby": "Big menu · Shop by column",
  "bb2-mega-preorder": "Big menu · Pre-Order column",
}

function Navigation() {
  const menus = useQuery(api.content.menus) as Menu[] | null | undefined
  const [open, setOpen] = useState<string | null>(null) // menu id, or "new"
  const [showOther, setShowOther] = useState(false)
  if (menus === undefined) return <Loading />
  if (menus === null) return null
  const used = menus.filter((m) => USED[m.handle]).sort((a, b) => Object.keys(USED).indexOf(a.handle) - Object.keys(USED).indexOf(b.handle))
  const other = menus.filter((m) => !USED[m.handle]).sort((a, b) => a.title.localeCompare(b.title))
  const editing = open === "new" ? null : menus.find((m) => m._id === open)
  if (open === "new" || editing) {
    return (
      <div className="mx-auto max-w-4xl pb-24">
        <WebsiteTabs active="navigation" />
        <MenuEditor key={editing?._id ?? "new"} menu={editing ?? null} label={editing ? USED[editing.handle] : undefined} onClose={() => setOpen(null)} onCreated={(id) => setOpen(id)} />
      </div>
    )
  }
  return (
    <div className="mx-auto max-w-6xl pb-24">
      <WebsiteTabs active="navigation" />
      <PageHeader title="Menus" subtitle="The menus at the top of the website, and old web addresses that should send visitors somewhere new."
        primary={<Button size="sm" onClick={() => setOpen("new")}>Create menu</Button>} />
      <div className="space-y-4">
        {menus.length === 0 ? (
          <EmptyImport icon={<ListTree className="size-5" />} what="menus" title="No menus in Ops yet"
            text="The website still uses the menus copied from Shopify. Copy them here once to edit them." />
        ) : (
          <Card flush>
            <table className="w-full text-[13px]">
              <thead><tr className="border-b bg-black/[0.03] text-left text-xs text-muted-foreground dark:bg-white/[0.03]"><th className="h-9 px-4 font-medium">Menu</th><th className="h-9 px-3 font-medium">Menu items</th></tr></thead>
              <tbody>
                <MenuRows list={used} onOpen={setOpen} />
                {other.length > 0 && (
                  <tr className="border-t"><td colSpan={2}>
                    <button type="button" onClick={() => setShowOther((s) => !s)} className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
                      {showOther ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}{other.length} other menus (not in the website header)
                    </button>
                  </td></tr>
                )}
                {showOther && <MenuRows list={other} onOpen={setOpen} />}
              </tbody>
            </table>
          </Card>
        )}
        <Redirects />
      </div>
    </div>
  )
}

function MenuRows({ list, onOpen }: { list: Menu[]; onOpen: (id: string) => void }) {
  return <>
    {list.map((m) => (
      <tr key={m._id} onClick={() => onOpen(m._id)} className="group cursor-pointer border-b last:border-0 hover:bg-black/[0.03] dark:hover:bg-white/[0.03]">
        <td className="px-4 py-3 align-top"><div className="font-semibold group-hover:underline">{USED[m.handle] ?? m.title}</div><div className="text-xs text-muted-foreground">{m.handle}</div></td>
        <td className="px-3 py-3 align-top text-muted-foreground"><div className="line-clamp-2">{m.items.map((i) => i.title).join(", ") || "No items"}</div><div className="text-xs">{countItems(m.items)} items</div></td>
      </tr>
    ))}
  </>
}

// ---------------------------------------------------------------- menu editor
const STEP = 28 // px per level, for the drag-to-nest gesture and the indent

function MenuEditor({ menu, label, onClose, onCreated }: { menu: Menu | null; label?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const save = useMutation(api.content.saveMenu)
  const del = useMutation(api.content.deleteMenu)
  const start = useMemo(() => ({ title: menu?.title ?? "", handle: menu?.handle ?? "", rows: flatten(menu?.items ?? []) }), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState(start)
  const [saved, setSaved] = useState(start)
  // compare the tree (not the row keys) for "unsaved changes"
  const shape = { title: f.title, handle: f.handle, items: build(f.rows) }
  const { dirty, markSaved } = useDirty(shape)
  const [saving, setSaving] = useState(false)
  const [edit, setEdit] = useState<{ index: number; parent: number; title: string; url: string } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const setRows = (rows: Row[]) => setF((x) => ({ ...x, rows }))
  const isNew = !menu

  async function onSave() {
    if (!f.title.trim()) { toast.error("Give the menu a name"); return }
    const empty = f.rows.find((r) => !r.title.trim())
    if (empty) { toast.error("Every menu item needs a name"); return }
    setSaving(true)
    try {
      const id = await save({ id: menu?._id, title: f.title, handle: f.handle || f.title, items: build(f.rows) })
      markSaved(shape); setSaved(f)
      toast.success("Menu saved — live on the website in about a minute")
      if (isNew) setTimeout(() => onCreated(id), 0)
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4">
      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onDiscard={() => setF(saved)} message={isNew ? "Unsaved menu" : "Unsaved changes"} />
      <PageHeader title={isNew ? "Add menu" : label ?? saved.title} onBack={() => { if (!dirty || window.confirm("Leave without saving your menu changes?")) onClose() }}
        more={menu ? [{ label: "Delete menu", destructive: true, icon: <Trash2 className="size-4" />, onClick: () => setConfirm(true) }] : undefined} />
      <Section>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" hint="Only staff see it."><Input autoFocus={isNew} value={f.title} onChange={(e) => setF((x) => ({ ...x, title: e.target.value }))} placeholder="e.g. Footer menu" /></Field>
          <Field label="Handle" hint={isNew ? "How the website finds this menu. Made from the name if empty." : "The website finds this menu by its handle, so it can't be changed."}>
            <Input value={f.handle} disabled={!isNew} onChange={(e) => setF((x) => ({ ...x, handle: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-") }))} placeholder="footer-menu" />
          </Field>
        </div>
      </Section>
      <Section title="Menu items" sub="Drag to reorder. Drag right to put an item under the one above it (up to 3 levels).">
        <Tree rows={f.rows} onChange={setRows} onEdit={(i) => setEdit({ index: i, parent: -1, title: f.rows[i].title, url: f.rows[i].url })}
          onAddChild={(i) => setEdit({ index: -1, parent: i, title: "", url: "" })} />
        <button type="button" onClick={() => setEdit({ index: -1, parent: -1, title: "", url: "" })}
          className="mt-2 flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-left text-[13px] font-medium text-tone-blue hover:bg-muted/40">
          <Plus className="size-4" /> Add menu item
        </button>
      </Section>

      <ItemDialog edit={edit} onClose={() => setEdit(null)} onSave={(title, url) => {
        if (!edit) return
        if (edit.index >= 0) setRows(f.rows.map((r, j) => (j === edit.index ? { ...r, title, url } : r)))
        else setRows(addChild(f.rows, edit.parent, { title, url, type: "HTTP" }))
        setEdit(null)
      }} />

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {label ?? `“${menu?.title}”`}?</DialogTitle>
            <DialogDescription>{menu && USED[menu.handle] ? "The website's header uses this menu, so it will fall back to the menu copied from Shopify." : "The menu and its items are removed."} This can't be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={async () => {
              try { await del({ id: menu!._id }); markSaved(shape); toast.success("Menu deleted"); setConfirm(false); setTimeout(onClose, 0) } catch (e) { toast.error(errMsg(e)) }
            }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** The menu items as one list with indents. Drag a row (with what's under it) up/down to move, left/right to change level. */
function Tree({ rows, onChange, onEdit, onAddChild }: { rows: Row[]; onChange: (r: Row[]) => void; onEdit: (i: number) => void; onAddChild: (i: number) => void }) {
  const [drag, setDrag] = useState<{ from: number; x: number } | null>(null)
  const [target, setTarget] = useState<{ to: number; depth: number } | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  if (!rows.length) return <p className="py-3 text-sm text-muted-foreground">No menu items yet.</p>
  const end = drag ? blockEnd(rows, drag.from) : -1

  const over = (e: React.DragEvent, j: number) => {
    if (!drag) return
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    let to = e.clientY < rect.top + rect.height / 2 ? j : j + 1
    if (to > drag.from && to < end) to = drag.from // inside itself = stay
    // allowed levels at that spot (the row above, not counting the dragged rows)
    let p = to - 1
    while (p >= drag.from && p < end) p--
    const { min, max } = depthRange(p >= 0 ? rows[p] : undefined, blockSpan(rows, drag.from))
    const depth = Math.max(min, Math.min(max, rows[drag.from].depth + Math.round((e.clientX - drag.x) / STEP)))
    if (!target || target.to !== to || target.depth !== depth) setTarget({ to, depth })
  }
  const drop = (e: React.DragEvent) => {
    e.preventDefault()
    if (drag && target) onChange(moveBlock(rows, drag.from, target.to, target.depth))
    setDrag(null); setTarget(null)
  }

  return (
    <ul ref={listRef} className="relative space-y-1" onDragOver={(e) => drag && e.preventDefault()} onDrop={drop}>
      {rows.map((r, i) => {
        const dragged = drag && i >= drag.from && i < end
        return (
          <li key={r.key} style={{ marginLeft: r.depth * STEP }} className="relative"
            onDragOver={(e) => over(e, i)}>
            {target && target.to === i && <DropLine depth={target.depth - r.depth} />}
            <div draggable
              onDragStart={(e) => { setDrag({ from: i, x: e.clientX }); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.key) }}
              onDragEnd={() => { setDrag(null); setTarget(null) }}
              className={cn("group flex items-center gap-2 rounded-lg border bg-background px-2 py-1.5", dragged && "opacity-40")}>
              <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground/60 active:cursor-grabbing" />
              {r.depth > 0 && <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground/60" />}
              <button type="button" onClick={() => onEdit(i)} className="min-w-0 flex-1 text-left">
                <div className={cn("truncate text-[13px] font-medium", !r.title.trim() && "text-tone-red")}>{r.title || "No name"}</div>
                <div className={cn("truncate text-xs", r.url && r.url !== "#" ? "text-muted-foreground" : "text-tone-amber")}>{r.url && r.url !== "#" ? r.url : "No link"}</div>
              </button>
              <div className="flex shrink-0 items-center opacity-60 group-hover:opacity-100">
                <Button size="icon-sm" variant="ghost" aria-label="Move up a level" title="Move up a level" disabled={r.depth === 0} onClick={() => onChange(shiftBlock(rows, i, -1))}><IndentDecrease className="size-4" /></Button>
                <Button size="icon-sm" variant="ghost" aria-label="Put under the item above" title="Put under the item above" disabled={i === 0 || r.depth >= MAX_DEPTH || rows[i - 1].depth < r.depth} onClick={() => onChange(shiftBlock(rows, i, 1))}><IndentIncrease className="size-4" /></Button>
                {r.depth < MAX_DEPTH && <Button size="icon-sm" variant="ghost" aria-label="Add item under this one" title="Add item under this one" onClick={() => onAddChild(i)}><Plus className="size-4" /></Button>}
                <Button size="icon-sm" variant="ghost" aria-label="Edit" title="Edit" onClick={() => onEdit(i)}><Pencil className="size-3.5" /></Button>
                <Button size="icon-sm" variant="ghost" aria-label="Delete" title={blockEnd(rows, i) > i + 1 ? "Delete (with the items under it)" : "Delete"} onClick={() => onChange(removeBlock(rows, i))}><Trash2 className="size-4" /></Button>
              </div>
            </div>
          </li>
        )
      })}
      {target && target.to === rows.length && <li className="relative h-2" style={{ marginLeft: target.depth * STEP }}><DropLine depth={0} /></li>}
    </ul>
  )
}

function DropLine({ depth }: { depth: number }) {
  return <div className="pointer-events-none absolute -top-[3px] right-0 z-10 h-0.5 rounded-full bg-tone-blue" style={{ left: depth * STEP }} />
}

function ItemDialog({ edit, onClose, onSave }: { edit: { index: number; title: string; url: string } | null; onClose: () => void; onSave: (title: string, url: string) => void }) {
  const [title, setTitle] = useState("")
  const [url, setUrl] = useState("")
  useEffect(() => { if (edit) { setTitle(edit.title); setUrl(edit.url === "#" ? "" : edit.url) } }, [edit])
  return (
    <Dialog open={!!edit} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{edit && edit.index >= 0 ? "Edit menu item" : "Add menu item"}</DialogTitle>
          <DialogDescription>What the link says and where it goes.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Label"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Sandals" /></Field>
          <Field label="Link"><LinkPicker value={url} onChange={(u, t) => { setUrl(u); if (t && !title.trim()) setTitle(t) }} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!title.trim()} onClick={() => onSave(title.trim(), url.trim() || "#")}>{edit && edit.index >= 0 ? "Done" : "Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LinkPicker({ value, onChange }: { value: string; onChange: (url: string, title?: string) => void }) {
  const targets = useQuery(api.content.linkTargets)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const s = q.trim().toLowerCase()
  const groups: [string, { title: string; url: string }[]][] = targets ? [
    ["Basics", [{ title: "Home", url: "/" }, { title: "All products", url: "/collections/all" }, { title: "Search", url: "/search" }, { title: "Track your order", url: "/pages/track-order" }]],
    ["Collections", targets.collections], ["Products", targets.products], ["Pages", targets.pages], ["Blogs", targets.blogs], ["Blog posts", targets.posts ?? []],
  ] : []
  const typed = q.trim()
  const looksLikeUrl = /^(https?:\/\/|\/|mailto:|tel:)/i.test(typed)
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setQ("") }}>
      <PopoverTrigger asChild>
        <button type="button" className={cn("flex h-9 w-full items-center gap-1.5 rounded-md border px-2.5 text-left text-sm hover:bg-muted/40", !value && "text-muted-foreground")}>
          <Link2 className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{value || "Search or paste a link"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-80 p-0">
        <div className="relative border-b">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && looksLikeUrl) { onChange(typed); setOpen(false) } }}
            placeholder="Search, or paste a web address" className="h-10 w-full bg-transparent pl-8 pr-2 text-sm outline-none" />
        </div>
        <div className="max-h-72 overflow-auto p-1">
          {looksLikeUrl && (
            <button type="button" onClick={() => { onChange(typed); setOpen(false) }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent">
              <Link2 className="size-3.5" /><span className="truncate">Use {typed}</span>
            </button>
          )}
          {!targets && <p className="px-2 py-4 text-center text-xs text-muted-foreground">Loading…</p>}
          {groups.map(([name, list]) => {
            const hits = list.filter((x) => !s || x.title.toLowerCase().includes(s) || x.url.toLowerCase().includes(s)).slice(0, s ? 30 : 5)
            if (!hits.length) return null
            return (
              <div key={name} className="mb-1">
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{name}</div>
                {hits.map((x) => (
                  <button key={name + x.url} type="button" onClick={() => { onChange(x.url, x.title); setOpen(false) }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent">
                    <span className="min-w-0 flex-1 truncate">{x.title}</span><span className="max-w-32 truncate text-[11px] text-muted-foreground">{x.url}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------- URL redirects
type Redirect = { _id: Id<"webRedirects">; path: string; target: string }
const PAGE = 100

function Redirects() {
  const rows = useQuery(api.content.redirects) as Redirect[] | null | undefined
  const save = useMutation(api.content.saveRedirect)
  const delMany = useMutation(api.content.deleteRedirects)
  const importRows = useMutation(api.content.importRedirects)
  const [q, setQ] = useState("")
  const [shown, setShown] = useState(PAGE)
  const [edit, setEdit] = useState<{ id?: Id<"webRedirects">; path: string; target: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [imp, setImp] = useState<{ rows: { path: string; target: string }[]; name: string; overwrite: boolean } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const s = q.trim().toLowerCase()
  const list = useMemo(() => (rows ?? []).filter((r) => !s || r.path.toLowerCase().includes(s) || r.target.toLowerCase().includes(s)), [rows, s])
  const sel = useSelection(list.map((r) => r._id))
  if (rows === undefined) return <Loading />
  if (rows === null) return null

  const exportCsv = (which: Redirect[]) => {
    const url = URL.createObjectURL(new Blob([redirectsToCsv(which)], { type: "text/csv" }))
    const a = document.createElement("a")
    a.href = url; a.download = `url-redirects-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
  }
  const onFile = async (file: File | undefined) => {
    if (!file) return
    const parsed = redirectsFromCsv(parseCsv(await file.text()))
    if (!parsed.length) { toast.error("No redirects found in that file. It needs “Redirect from” and “Redirect to” columns."); return }
    setImp({ rows: parsed, name: file.name, overwrite: false })
  }
  const runImport = async () => {
    if (!imp) return
    setBusy(true)
    const total = { added: 0, updated: 0, skipped: 0, errors: [] as string[] }
    try {
      for (let i = 0; i < imp.rows.length; i += 500) {
        const r = await importRows({ rows: imp.rows.slice(i, i + 500), overwrite: imp.overwrite })
        total.added += r.added; total.updated += r.updated; total.skipped += r.skipped; total.errors.push(...r.errors)
      }
      toast.success(`Imported: ${total.added} added, ${total.updated} updated, ${total.skipped} skipped`, { description: total.errors.slice(0, 3).join(" · ") || undefined })
      setImp(null)
    } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <Card flush title="URL redirects" action={<>
      <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}><Upload className="size-4" /> Import</Button>
      <Button size="sm" variant="ghost" disabled={!rows.length} onClick={() => exportCsv(sel.count ? rows.filter((r) => sel.has(r._id)) : list)}><Download className="size-4" /> Export</Button>
      <Button size="sm" variant="outline" onClick={() => setEdit({ path: "", target: "" })}><Plus className="size-4" /> Create URL redirect</Button>
    </>}>
      <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = "" }} />
      <p className="px-4 pb-3 text-xs text-muted-foreground">Send visitors from an old web address (e.g. a product you renamed) to a new one, so links and Google results keep working.</p>
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 border-t px-4 py-8 text-center text-sm text-muted-foreground">
          No redirects in Ops yet. The website still uses the ones from Shopify until you copy them here.
          <ImportButton what="redirects" label="Copy redirects from the website" />
        </div>
      ) : <>
        <div className="border-t"><IndexSearch value={q} onChange={(v) => { setQ(v); setShown(PAGE) }} placeholder="Search redirects" /></div>
        <IndexTable<Redirect>
          rows={list.slice(0, shown)} rowId={(r) => r._id} sel={sel} total={list.length}
          onRowClick={(r) => setEdit({ id: r._id, path: r.path, target: r.target })}
          bulk={<Button size="sm" variant="outline" onClick={() => exportCsv(rows.filter((r) => sel.has(r._id)))}><Download className="size-4" /> Export</Button>}
          bulkMore={[{ label: "Delete redirects", destructive: true, icon: <Trash2 className="size-4" />, onClick: async () => {
            if (!window.confirm(`Delete ${sel.count} redirect${sel.count === 1 ? "" : "s"}? Their old addresses will show “page not found”.`)) return
            try { const n = await delMany({ ids: [...sel.selected] as Id<"webRedirects">[] }); sel.clear(); toast.success(`${n} redirect${n === 1 ? "" : "s"} deleted`) } catch (e) { toast.error(errMsg(e)) }
          } }]}
          empty={<p className="px-4 py-8 text-center text-sm text-muted-foreground">No redirect matches.</p>}
          columns={[
            { key: "from", label: "Redirect from", render: (r) => <span className="break-all font-mono text-xs">{r.path}</span> },
            { key: "arrow", label: "", className: "w-6 text-muted-foreground", render: () => <ArrowRight className="size-3.5" /> },
            { key: "to", label: "Redirect to", render: (r) => <span className="break-all font-mono text-xs">{r.target}</span> },
          ]}
        />
        <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
          <span>{list.length === rows.length ? `${rows.length} redirects` : `${list.length} of ${rows.length} redirects`}</span>
          {list.length > shown && <Button size="sm" variant="ghost" onClick={() => setShown((n) => n + PAGE * 5)}>Show more</Button>}
        </div>
      </>}

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{edit?.id ? "Edit URL redirect" : "Create URL redirect"}</DialogTitle>
            <DialogDescription>Anyone opening the old address is sent to the new one.</DialogDescription>
          </DialogHeader>
          {edit && (
            <div className="space-y-3">
              <Field label="Redirect from" hint="e.g. /products/old-name"><Input autoFocus value={edit.path} onChange={(e) => setEdit({ ...edit, path: e.target.value })} placeholder="/products/old-name" /></Field>
              <Field label="Redirect to" hint="A path on the website, or a full web address"><Input value={edit.target} onChange={(e) => setEdit({ ...edit, target: e.target.value })} placeholder="/products/new-name" /></Field>
            </div>
          )}
          <DialogFooter className="sm:justify-between">
            {edit?.id ? <Button variant="ghost" className="text-tone-red" onClick={async () => {
              try { await delMany({ ids: [edit.id!] }); toast.success("Redirect deleted"); setEdit(null) } catch (e) { toast.error(errMsg(e)) }
            }}><Trash2 className="size-4" /> Delete</Button> : <span />}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button>
              <Button disabled={busy} onClick={async () => {
                if (!edit) return
                setBusy(true)
                try { await save({ id: edit.id, path: edit.path, target: edit.target }); toast.success("Redirect saved"); setEdit(null) } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
              }}>Save</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!imp} onOpenChange={(o) => !o && !busy && setImp(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import URL redirects</DialogTitle>
            <DialogDescription>{imp ? `${imp.rows.length} redirect${imp.rows.length === 1 ? "" : "s"} found in ${imp.name}.` : ""}</DialogDescription>
          </DialogHeader>
          {imp && (
            <div className="space-y-3 text-[13px]">
              <div className="max-h-48 overflow-auto rounded-md border font-mono text-xs">
                {imp.rows.slice(0, 8).map((r, i) => <div key={i} className="flex gap-2 border-b px-2 py-1 last:border-0"><span className="truncate">{r.path}</span><ArrowRight className="size-3 shrink-0" /><span className="truncate">{r.target}</span></div>)}
                {imp.rows.length > 8 && <div className="px-2 py-1 text-muted-foreground">…and {imp.rows.length - 8} more</div>}
              </div>
              <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 accent-foreground" checked={imp.overwrite} onChange={(e) => setImp({ ...imp, overwrite: e.target.checked })} />
                Replace existing redirects that have the same “Redirect from” address</label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setImp(null)}>Cancel</Button>
            <Button disabled={busy} onClick={runImport}>{busy ? "Importing…" : "Import redirects"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
