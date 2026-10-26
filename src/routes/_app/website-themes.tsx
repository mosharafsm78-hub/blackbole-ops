import { useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useAction, useMutation, useQuery } from "convex/react"
import { Download, ExternalLink, History, Loader2, MoreHorizontal, Paintbrush, Pencil, RotateCcw, Rocket, Trash2, Copy } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { WebsiteGuard } from "@/components/app-shell"
import { Loading } from "@/components/bits"
import { WebsiteHeader, ago } from "@/components/content-ui"
import { DRAFT_URL, LIVE_URL, PreviewBadge, SiteThumb, usePreviewState } from "@/components/theme-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { errMsg } from "@/lib/format"

export const Route = createFileRoute("/_app/website-themes")({
  component: () => <WebsiteGuard><Themes /></WebsiteGuard>,
})

type Meta = { _id: Id<"webThemes">; name: string; role: string; updatedAt: number; updatedBy: string | null; publishedAt: number | null; publishedBy: string | null }

function Themes() {
  const o = useQuery(api.themes.overview)
  const navigate = useNavigate()
  const publish = useMutation(api.themes.publish)
  const rollback = useMutation(api.themes.rollback)
  const copyToDraft = useMutation(api.themes.copyToDraft)
  const remove = useMutation(api.themes.remove)
  const rebuildPreview = useMutation(api.themes.rebuildPreview)
  const [confirm, setConfirm] = useState<null | { title: string; text: string; button: string; run: () => Promise<unknown> }>(null)
  const [renaming, setRenaming] = useState<Meta | null>(null)
  const preview = usePreviewState(o?.draft?.updatedAt, !!o?.draft && !!o?.draftHook)

  if (o === undefined) return <Loading />
  if (o === null) return null
  const ask = (title: string, text: string, button: string, run: () => Promise<unknown>) => setConfirm({ title, text, button, run })
  const previous = o.archived.find((a) => a.publishedAt) ?? o.archived[0]

  return (
    <div className="mx-auto max-w-6xl">
      <WebsiteHeader active="themes" sub="How the website looks. Change the draft safely, check it on the preview site, then publish.">
        {o.live && <Button size="sm" variant="outline" asChild><a href={LIVE_URL} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> View website</a></Button>}
      </WebsiteHeader>

      {!o.live ? <ImportEmpty /> : (
        <div className="space-y-6">
          {/* Live */}
          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="grid gap-0 md:grid-cols-[320px_1fr]">
              <a href={LIVE_URL} target="_blank" rel="noreferrer" className="block p-4 pb-0 md:pb-4"><SiteThumb url={LIVE_URL} className="aspect-[4/3] w-full" /></a>
              <div className="flex flex-col p-4 md:pl-2">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-tone-green/15 px-2 py-0.5 text-xs font-medium text-tone-green">Live</span>
                  <span className="text-xs text-muted-foreground">What customers see now</span>
                </div>
                <h2 className="mt-2 text-lg font-semibold">{o.live.name}</h2>
                <p className="text-sm text-muted-foreground">{o.live.publishedAt ? `Published ${ago(o.live.publishedAt)}${o.live.publishedBy ? ` by ${o.live.publishedBy}` : ""}` : ""}</p>
                {o.liveBuild?.pending && <p className="mt-1 text-xs text-tone-blue">Website updating — live in about a minute.</p>}
                <div className="mt-auto flex flex-wrap gap-2 pt-4">
                  <Button size="sm" variant="outline" asChild><a href={LIVE_URL} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> View</a></Button>
                  <Button size="sm" variant="outline" onClick={() => ask("Edit a copy of the live theme?", o.draft ? `The current draft “${o.draft.name}” is kept in the theme library, and a fresh copy of the live theme becomes the draft.` : "A copy of the live theme becomes the draft.", "Make draft", async () => { await copyToDraft({ id: o.live!._id }); toast.success("Draft ready") })}>
                    <Copy className="size-4" /> Edit a copy
                  </Button>
                  {previous && (
                    <Button size="sm" variant="outline" onClick={() => ask("Roll back the website?", `“${previous.name}”${previous.publishedAt ? ` (live ${ago(previous.publishedAt)})` : ""} goes live again in about a minute. The current live theme stays in the theme library, so you can come back to it.`, "Roll back", async () => { const r = await rollback({}); toast.success(`“${r.name}” is going live`) })}>
                      <RotateCcw className="size-4" /> Roll back
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Draft */}
          {o.draft ? (
            <section className="overflow-hidden rounded-xl border bg-card">
              <div className="grid gap-0 md:grid-cols-[320px_1fr]">
                <a href={DRAFT_URL} target="_blank" rel="noreferrer" className="block p-4 pb-0 md:pb-4">
                  {o.draftHook ? <SiteThumb url={DRAFT_URL} className="aspect-[4/3] w-full" /> : <div className="flex aspect-[4/3] w-full items-center justify-center rounded-lg border bg-muted text-sm text-muted-foreground">Preview site not connected</div>}
                </a>
                <div className="flex flex-col p-4 md:pl-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-tone-blue/15 px-2 py-0.5 text-xs font-medium text-tone-blue">Draft</span>
                    <PreviewBadge state={preview.state} hook={o.draftHook} />
                  </div>
                  <div className="mt-2 flex items-center gap-1">
                    <h2 className="text-lg font-semibold">{o.draft.name}</h2>
                    <Button size="icon" variant="ghost" className="size-7" onClick={() => setRenaming(o.draft as Meta)} aria-label="Rename"><Pencil className="size-3.5" /></Button>
                  </div>
                  <p className="text-sm text-muted-foreground">Saved {ago(o.draft.updatedAt)}{o.draft.updatedBy ? ` by ${o.draft.updatedBy}` : ""}. Changes here never touch the live website until you publish.</p>
                  <p className="mt-1 text-sm">Preview site: <a href={DRAFT_URL} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">{DRAFT_URL.replace("https://", "")}</a></p>
                  {!o.draftHook && <p className="mt-2 rounded-md bg-tone-amber/10 px-3 py-2 text-xs text-tone-amber">The preview site needs a one-time setup (Cloudflare deploy hook for the “draft” branch → Convex setting WEBSITE_DRAFT_HOOK). Until then you can still edit and publish; you just can’t preview first.</p>}
                  <div className="mt-auto flex flex-wrap gap-2 pt-4">
                    <Button size="sm" onClick={() => navigate({ to: "/website-theme-editor", search: { id: o.draft!._id, page: "home" } })}><Paintbrush className="size-4" /> Customize</Button>
                    <Button size="sm" variant="outline" asChild><a href={DRAFT_URL} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> Preview</a></Button>
                    <Button size="sm" variant="outline" onClick={() => ask("Publish the draft?", `“${o.draft!.name}” becomes the live website in about a minute. The current live theme goes to the theme library — one click on Roll back brings it back.`, "Publish", async () => { await publish({ id: o.draft!._id }); toast.success("Published — live in about a minute") })}>
                      <Rocket className="size-4" /> Publish
                    </Button>
                    {o.draftHook && <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={async () => { await rebuildPreview({}); toast.success("Preview site is rebuilding"); setTimeout(preview.recheck, 2000) }}>Rebuild preview</Button>}
                  </div>
                </div>
              </div>
            </section>
          ) : (
            <section className="rounded-xl border border-dashed bg-card p-6 text-center">
              <p className="font-medium">No draft theme</p>
              <p className="mt-1 text-sm text-muted-foreground">Make a copy of the live theme to change it safely.</p>
              <Button size="sm" className="mt-3" onClick={async () => { try { await copyToDraft({ id: o.live!._id }) } catch (e) { toast.error(errMsg(e)) } }}><Copy className="size-4" /> Edit a copy</Button>
            </section>
          )}

          {/* Library */}
          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <History className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Theme library</h3>
              <span className="text-xs text-muted-foreground">Earlier versions — the newest 10 are kept</span>
            </div>
            {o.archived.length === 0 ? <p className="px-4 py-6 text-sm text-muted-foreground">Every time you publish, the theme that was live is kept here so you can go back to it.</p> : (
              <ul>
                {o.archived.map((t) => (
                  <li key={t._id} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-0">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{t.name}</div>
                      <div className="text-xs text-muted-foreground">{t.publishedAt ? `Was live from ${new Date(t.publishedAt).toLocaleString()}${t.publishedBy ? ` · ${t.publishedBy}` : ""}` : `Saved ${ago(t.updatedAt)}`}</div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => ask("Put this theme live again?", `“${t.name}” goes live in about a minute. The current live theme is kept in the library.`, "Publish", async () => { await rollback({ id: t._id }); toast.success("Going live in about a minute") })}>Publish</Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="size-8" aria-label="More"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={async () => { try { await copyToDraft({ id: t._id }); toast.success("Copied to the draft") } catch (e) { toast.error(errMsg(e)) } }}><Copy className="size-4" /> Copy to draft</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setRenaming(t as Meta)}><Pencil className="size-4" /> Rename</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-tone-red" onClick={() => ask("Delete this theme?", `“${t.name}” is removed from the library for good.`, "Delete", async () => { await remove({ id: t._id }) })}><Trash2 className="size-4" /> Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="text-xs text-muted-foreground">Pictures and videos for the theme live in <Link to="/website-files" className="underline">Files</Link>. Texts like the announcement bar, delivery charges and contact details are in <Link to="/website-settings" className="underline">Settings</Link>.</p>
        </div>
      )}

      <Dialog open={!!confirm} onOpenChange={(v) => { if (!v) setConfirm(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{confirm?.title}</DialogTitle><DialogDescription>{confirm?.text}</DialogDescription></DialogHeader>
          <ConfirmFooter confirm={confirm} onDone={() => setConfirm(null)} />
        </DialogContent>
      </Dialog>
      <RenameDialog theme={renaming} onClose={() => setRenaming(null)} />
    </div>
  )
}

function ConfirmFooter({ confirm, onDone }: { confirm: { button: string; run: () => Promise<unknown> } | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <DialogFooter>
      <Button variant="outline" onClick={onDone}>Cancel</Button>
      <Button disabled={busy} onClick={async () => {
        if (!confirm) return
        setBusy(true)
        try { await confirm.run(); onDone() } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
      }}>{busy && <Loader2 className="size-4 animate-spin" />} {confirm?.button}</Button>
    </DialogFooter>
  )
}

function RenameDialog({ theme, onClose }: { theme: Meta | null; onClose: () => void }) {
  const rename = useMutation(api.themes.rename)
  const [name, setName] = useState("")
  const [id, setId] = useState("")
  if (theme && theme._id !== id) { setId(theme._id); setName(theme.name) }
  return (
    <Dialog open={!!theme} onOpenChange={(v) => { if (!v) { onClose(); setId("") } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Rename theme</DialogTitle></DialogHeader>
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={async () => { try { await rename({ id: theme!._id, name }); onClose(); setId("") } catch (e) { toast.error(errMsg(e)) } }}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ImportEmpty() {
  const run = useAction(api.themes.importCurrent)
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex flex-col items-center rounded-xl border bg-card px-6 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted"><Paintbrush className="size-5" /></div>
      <h2 className="mt-3 font-semibold">Bring the website’s theme into Ops</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">Copies how the website looks today. It becomes your <b>Live</b> theme, plus a <b>Draft</b> copy you can change — banners, tiles, texts, section order — and check on the preview site before publishing. Nothing on the website changes.</p>
      <Button className="mt-4" disabled={busy} onClick={async () => {
        setBusy(true)
        try { await run({}); toast.success("Theme copied into Ops") } catch (e) { toast.error(errMsg(e)) } finally { setBusy(false) }
      }}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Import current theme</Button>
    </div>
  )
}
