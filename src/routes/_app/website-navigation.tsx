import { useEffect, useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery } from "convex/react"
import { ArrowRight, ChevronDown, ChevronRight, CornerDownRight, GripVertical, Link2, ListTree, Pencil, Plus, Search, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { EmptyImport, ImportButton, WebsiteHeader } from "@/components/content-ui"
import { Field, SaveBar, Section, useDirty, useReorder } from "@/components/website-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { errMsg } from "@/lib/format"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_app/website-navigation")({
  component: () => <WebsiteGuard><TooltipProvider delayDuration={200}><Navigation /></TooltipProvider></WebsiteGuard>,
})

type Item = { title: string; url: string; type?: string; items: Item[] }
type Menu = { _id: Id<"webMenus">; handle: string; title: string; items: Item[] }

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
  const menus = useQuery(api.content.menus)
  const [open, setOpen] = useState<string | null>(null)
  const [showOther, setShowOther] = useState(false)
  if (menus === undefined) return <Loading />
  if (menus === null) return null
  const used = menus.filter((m) => USED[m.handle]).sort((a, b) => Object.keys(USED).indexOf(a.handle) - Object.keys(USED).indexOf(b.handle))
  const other = menus.filter((m) => !USED[m.handle]).sort((a, b) => a.title.localeCompare(b.title))
  const editing = menus.find((m) => m._id === open)
  return (
    <div className="mx-auto max-w-6xl pb-24">
      <WebsiteHeader active="navigation" sub="The menus at the top of the website, and old web addresses that should send visitors somewhere new." />
      {editing ? <MenuEditor key={editing._id} menu={editing as Menu} label={USED[editing.handle]} onClose={() => setOpen(null)} /> : (
        <div className="space-y-6">
          {menus.length === 0 ? (
            <EmptyImport icon={<ListTree className="size-5" />} what="menus" title="No menus in Ops yet"
              text="The website still uses the menus copied from Shopify. Copy them here once to edit them." />
          ) : (
            <Section title="Menus" sub="Click a menu to change its links. Changes go live in about a minute." flush>
              <MenuRows list={used} onOpen={setOpen} />
              {other.length > 0 && (
                <div className="border-t">
                  <button type="button" onClick={() => setShowOther((s) => !s)} className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
                    {showOther ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}{other.length} older menus from Shopify (not shown on the website)
                  </button>
                  {showOther && <MenuRows list={other} onOpen={setOpen} />}
                </div>
              )}
            </Section>
          )}
          <Redirects />
        </div>
      )}
    </div>
  )
}

function count(items: Item[]): number { return items.reduce((n, i) => n + 1 + count(i.items || []), 0) }

function MenuRows({ list, onOpen }: { list: { _id: string; handle: string; title: string; items: Item[] }[]; onOpen: (id: string) => void }) {
  return (
    <div className="divide-y border-t">
      {list.map((m) => (
        <button key={m._id} type="button" onClick={() => onOpen(m._id)} className="group flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40">
          <ListTree className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-medium group-hover:underline">{USED[m.handle] ?? m.title}</div>
            <div className="truncate text-xs text-muted-foreground">{m.items.slice(0, 6).map((i) => i.title).join(", ")}{m.items.length > 6 ? "…" : ""}</div>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">{count(m.items)} links</span>
          <Pencil className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- menu editor
function MenuEditor({ menu, label, onClose }: { menu: Menu; label?: string; onClose: () => void }) {
  const save = useMutation(api.content.saveMenu)
  const start = useMemo(() => ({ title: menu.title, items: menu.items }), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState(start)
  const [saved, setSaved] = useState(start)
  const { dirty, markSaved } = useDirty(f)
  const [saving, setSaving] = useState(false)
  const setItems = (items: Item[]) => setF((x) => ({ ...x, items }))

  async function onSave() {
    setSaving(true)
    try {
      await save({ id: menu._id, title: f.title, handle: menu.handle, items: f.items })
      markSaved(f); setSaved(f)
      toast.success("Menu saved — live on the website in about a minute")
    } catch (e) { toast.error(errMsg(e)) } finally { setSaving(false) }
  }
  return (
    <div className="space-y-4">
      <SaveBar dirty={dirty} saving={saving} onSave={onSave} onDiscard={() => setF(saved)} />
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => { if (!dirty || window.confirm("Leave without saving your menu changes?")) onClose() }}>← All menus</Button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{label ?? f.title}</h2>
        <Button size="sm" disabled={!dirty || saving} onClick={onSave}>{saving ? "Saving" : "Save"}</Button>
      </div>
      <Section title="Links" sub="Drag to reorder. Use “Add sub-link” for a dropdown under a link.">
        <ItemList items={f.items} onChange={setItems} depth={0} />
        <Button size="sm" variant="outline" className="mt-3" onClick={() => setItems([...f.items, { title: "", url: "", type: "HTTP", items: [] }])}><Plus className="size-4" /> Add link</Button>
      </Section>
      <Section title="Menu name"><Field label="Name (only staff see it)" hint={`Handle: ${menu.handle}`}><Input value={f.title} onChange={(e) => setF((x) => ({ ...x, title: e.target.value }))} className="max-w-sm" /></Field></Section>
    </div>
  )
}

function ItemList({ items, onChange, depth }: { items: Item[]; onChange: (v: Item[]) => void; depth: number }) {
  const { props, drag, over } = useReorder(items, onChange)
  const setAt = (i: number, patch: Partial<Item>) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  if (!items.length) return depth === 0 ? <p className="py-4 text-sm text-muted-foreground">No links yet.</p> : null
  return (
    <ul className={cn("space-y-1.5", depth > 0 && "ml-6 mt-1.5 border-l pl-3")}>
      {items.map((it, i) => (
        <li key={i}>
          <div {...props(i)} className={cn("flex items-center gap-2 rounded-lg border bg-background p-1.5", drag === i && "opacity-40", over === i && drag !== i && "ring-2 ring-primary/40")}>
            <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground/60 active:cursor-grabbing" />
            {depth > 0 && <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground/60" />}
            <Input value={it.title} onChange={(e) => setAt(i, { title: e.target.value })} placeholder="Link name" className={cn("h-8 w-48", !it.title.trim() && "border-tone-amber")} />
            <LinkPicker value={it.url} onChange={(url, title) => setAt(i, { url, ...(title && !it.title.trim() ? { title } : {}) })} />
            {depth < 2 && <Button size="sm" variant="ghost" className="h-8 shrink-0 text-xs" onClick={() => setAt(i, { items: [...(it.items || []), { title: "", url: "", type: "HTTP", items: [] }] })}><Plus className="size-3.5" /> Sub-link</Button>}
            <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label="Remove link" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
          </div>
          <ItemList items={it.items || []} onChange={(v) => setAt(i, { items: v })} depth={depth + 1} />
        </li>
      ))}
    </ul>
  )
}

function LinkPicker({ value, onChange }: { value: string; onChange: (url: string, title?: string) => void }) {
  const targets = useQuery(api.content.linkTargets)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [custom, setCustom] = useState(value)
  useEffect(() => { if (open) { setCustom(value); setQ("") } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const s = q.trim().toLowerCase()
  const groups: [string, { title: string; url: string }[]][] = targets ? [
    ["Basics", [{ title: "Home", url: "/" }, { title: "All products", url: "/collections/all" }, { title: "Search", url: "/search" }]],
    ["Collections", targets.collections], ["Products", targets.products], ["Pages", targets.pages], ["Blogs", targets.blogs],
  ] : []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn("flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2.5 text-left text-sm hover:bg-muted/40", !value && "border-tone-amber text-muted-foreground")}>
          <Link2 className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{value || "Choose where it goes"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="relative border-b">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search collections, products, pages" className="h-10 w-full bg-transparent pl-8 pr-2 text-sm outline-none" />
        </div>
        <div className="max-h-72 overflow-auto p-1">
          {!targets && <p className="px-2 py-4 text-center text-xs text-muted-foreground">Loading…</p>}
          {groups.map(([name, list]) => {
            const hits = list.filter((x) => !s || x.title.toLowerCase().includes(s) || x.url.includes(s)).slice(0, s ? 30 : 6)
            if (!hits.length) return null
            return (
              <div key={name} className="mb-1">
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{name}</div>
                {hits.map((x) => (
                  <button key={x.url} type="button" onClick={() => { onChange(x.url, x.title); setOpen(false) }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent">
                    <span className="min-w-0 flex-1 truncate">{x.title}</span><span className="max-w-28 truncate text-[11px] text-muted-foreground">{x.url}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
        <div className="flex gap-2 border-t p-2">
          <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="/collections/men or https://…" className="h-8 text-xs" />
          <Button size="sm" className="h-8" disabled={!custom.trim()} onClick={() => { onChange(custom.trim()); setOpen(false) }}>Use</Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------- URL redirects
function Redirects() {
  const rows = useQuery(api.content.redirects)
  const save = useMutation(api.content.saveRedirect)
  const del = useMutation(api.content.deleteRedirect)
  const [q, setQ] = useState("")
  const [edit, setEdit] = useState<{ id?: Id<"webRedirects">; path: string; target: string } | null>(null)
  const [busy, setBusy] = useState(false)
  if (rows === undefined) return <Loading />
  if (rows === null) return null
  const s = q.trim().toLowerCase()
  const list = rows.filter((r) => !s || r.path.toLowerCase().includes(s) || r.target.toLowerCase().includes(s))
  return (
    <Section title="URL redirects" sub="Send visitors from an old web address (e.g. a product you renamed) to a new one, so links and Google results keep working."
      action={<><ImportButton what="redirects" label="Copy from website" /><Button size="sm" onClick={() => setEdit({ path: "", target: "" })}><Plus className="size-4" /> Add redirect</Button></>} flush>
      {rows.length > 8 && (
        <div className="px-4 pb-2">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search redirects" className="h-8 pl-8" />
          </div>
        </div>
      )}
      {rows.length === 0 ? <p className="border-t px-4 py-8 text-center text-sm text-muted-foreground">No redirects in Ops yet. The website still uses the ones from Shopify until you copy them here.</p> : (
        <div className="max-h-[28rem] overflow-auto border-t">
          <table className="w-full text-sm">
            <tbody>
              {list.map((r) => (
                <tr key={r._id} className="group border-b last:border-0 hover:bg-muted/40">
                  <td className="max-w-0 py-2 pl-4 pr-2"><div className="truncate font-mono text-xs">{r.path}</div></td>
                  <td className="w-6 text-muted-foreground"><ArrowRight className="size-3.5" /></td>
                  <td className="max-w-0 py-2 pr-2"><div className="truncate font-mono text-xs">{r.target}</div></td>
                  <td className="w-24 py-2 pr-3 text-right">
                    <Button size="icon" variant="ghost" className="size-7 opacity-0 group-hover:opacity-100" aria-label="Edit" onClick={() => setEdit({ id: r._id, path: r.path, target: r.target })}><Pencil className="size-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="size-7 opacity-0 group-hover:opacity-100" aria-label="Delete" onClick={async () => {
                      try { await del({ id: r._id }); toast.success("Redirect removed") } catch (e) { toast.error(errMsg(e)) }
                    }}><X className="size-3.5" /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{edit?.id ? "Edit redirect" : "Add redirect"}</DialogTitle>
            <DialogDescription>Anyone opening the old address is sent to the new one.</DialogDescription>
          </DialogHeader>
          {edit && (
            <div className="space-y-3">
              <Field label="Old address" hint="e.g. /products/old-name"><Input autoFocus value={edit.path} onChange={(e) => setEdit({ ...edit, path: e.target.value })} placeholder="/products/old-name" /></Field>
              <Field label="New address" hint="e.g. /products/new-name"><Input value={edit.target} onChange={(e) => setEdit({ ...edit, target: e.target.value })} placeholder="/products/new-name" /></Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button>
            <Button disabled={busy} onClick={async () => {
              if (!edit) return
              setBusy(true)
              try { await save({ id: edit.id, path: edit.path, target: edit.target }); toast.success("Redirect saved"); setEdit(null) } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
            }}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  )
}
