// Shared bits for Website → Themes and the theme editor.
import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

/** The preview site: Cloudflare builds the "draft" branch with the Draft theme from Ops. */
export const DRAFT_URL = "https://draft.blackbole-site.pages.dev"
/** The live site on Cloudflare (blackbole.com points here after the domain switch). */
export const LIVE_URL = "https://blackbole-site.pages.dev"

export type PreviewState = "unknown" | "updating" | "ready" | "offline"

/** Is the preview site already showing the draft saved at `updatedAt`? Checks /data/theme-export.json every 15 s. */
export function usePreviewState(updatedAt: number | null | undefined, enabled = true) {
  const [state, setState] = useState<PreviewState>("unknown")
  const [builtAt, setBuiltAt] = useState(0)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled || !updatedAt) return
    let stop = false
    const check = async () => {
      try {
        const r = await fetch(`${DRAFT_URL}/data/theme-export.json?t=${Date.now()}`, { cache: "no-store" })
        if (!r.ok) throw new Error(String(r.status))
        const j = await r.json()
        const at = Number(j?.meta?.updatedAt) || 0
        if (stop) return
        setBuiltAt(at)
        setState(at >= updatedAt ? "ready" : "updating")
        return at >= updatedAt
      } catch {
        if (!stop) setState("offline")
        return false
      }
    }
    let timer: ReturnType<typeof setTimeout>
    const loop = async () => { const done = await check(); if (!stop && !done) timer = setTimeout(loop, 15000) }
    loop()
    return () => { stop = true; clearTimeout(timer) }
  }, [updatedAt, enabled, tick])
  return { state, builtAt, recheck: () => setTick((n) => n + 1) }
}

export function PreviewBadge({ state, hook }: { state: PreviewState; hook: boolean }) {
  const [label, tone] = !hook ? ["Preview site not connected", "bg-tone-amber/15 text-tone-amber"]
    : state === "ready" ? ["Preview up to date", "bg-tone-green/15 text-tone-green"]
    : state === "updating" ? ["Preview updating… (1–3 min)", "bg-tone-blue/15 text-tone-blue"]
    : state === "offline" ? ["Preview site not reachable yet", "bg-tone-amber/15 text-tone-amber"]
    : ["Checking preview…", "bg-muted text-muted-foreground"]
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", tone)}>
      {state === "updating" && hook && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {label}
    </span>
  )
}

export type DraftBuild = { due: number; pending: boolean; queuedAt?: number } | null | undefined
export type LastBuild = { at: number; ok: boolean; status: number } | null | undefined

const since = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`
}

/** Where the preview site's build is: waiting for more saves, building, up to date or failed — in plain words. */
export function previewStatus(o: { hook: boolean; state: PreviewState; builtAt: number; build: DraftBuild; last: LastBuild; now: number }) {
  const { hook, state, builtAt, build, last, now } = o
  type S = { label: string; tone: "green" | "blue" | "amber" | "red" | "muted"; detail: string; busy?: boolean; retry?: boolean }
  const s = (label: string, tone: S["tone"], detail: string, extra: Partial<S> = {}): S => ({ label, tone, detail, ...extra })
  if (!hook) return s("Preview site not connected", "amber", "The preview site needs a one-time setup: a Cloudflare deploy hook for the “draft” branch in the Convex setting WEBSITE_DRAFT_HOOK. Live editing still works; saved changes reach the website when you publish.")
  if (build?.pending) {
    const wait = Math.ceil((build.due - now) / 1000)
    return wait > 0
      ? s(`Preview build starts in ${wait} s`, "blue", "Saves close together are built once: the preview site starts building about 45 seconds after the last save and takes 1–3 minutes.", { busy: true })
      : s("Starting preview build…", "blue", "Asking Cloudflare to build the preview site.", { busy: true })
  }
  if (last && !last.ok && last.at >= (build?.queuedAt ?? 0) && state !== "ready")
    return s("Preview build failed", "red", `Cloudflare didn't accept the build request ${since(last.at, now)} (${last.status ? `HTTP ${last.status}` : "no answer"}). Check the deploy hook in WEBSITE_DRAFT_HOOK, then rebuild.`, { retry: true })
  if (state === "updating") {
    const started = last?.at ? ` Build requested ${since(last.at, now)}.` : ""
    return last?.at && now - last.at > 10 * 60 * 1000
      ? s("Preview build is taking long", "amber", `The preview site still shows an older save.${started} Cloudflare may have failed the build; try rebuilding.`, { retry: true })
      : s("Preview building… (1–3 min)", "blue", `The preview site is building your last save.${started} The preview reloads by itself when it's ready.`, { busy: true })
  }
  if (state === "ready") return s("Preview up to date", "green", `The preview site shows your last save${builtAt ? ` (saved ${since(builtAt, now)})` : ""}.`)
  if (state === "offline") return s("Preview site not reachable", "amber", "The preview site didn't answer. It may still be building for the first time.", { retry: true })
  return s("Checking preview…", "muted", "Asking the preview site which save it shows.")
}

const TONE = { green: "bg-tone-green/15 text-tone-green", blue: "bg-tone-blue/15 text-tone-blue", amber: "bg-tone-amber/15 text-tone-amber", red: "bg-tone-red/15 text-tone-red", muted: "bg-muted text-muted-foreground" }

/** The preview build status badge; hover for the details. Offers a rebuild when the build failed or got stuck. */
export function PreviewStatus({ hook, state, builtAt, build, last, onRebuild, className }: {
  hook: boolean; state: PreviewState; builtAt: number; build: DraftBuild; last: LastBuild; onRebuild?: () => void; className?: string
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const st = previewStatus({ hook, state, builtAt, build, last, now })
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span title={st.detail} className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", TONE[st.tone])}>
        {st.busy && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
        {st.label}
      </span>
      {st.retry && onRebuild && <button type="button" onClick={onRebuild} className="whitespace-nowrap text-xs font-medium underline underline-offset-2">Rebuild</button>}
    </span>
  )
}

/** A small live picture of a website page (scaled-down iframe), like Shopify's theme thumbnails. */
export function SiteThumb({ url, className }: { url: string; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-lg border bg-muted", className)}>
      <iframe src={url} title="Website preview" loading="lazy" tabIndex={-1} aria-hidden
        className="pointer-events-none absolute left-0 top-0 h-[400%] w-[400%] origin-top-left scale-25 border-0" />
    </div>
  )
}
