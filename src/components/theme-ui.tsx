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

/** A small live picture of a website page (scaled-down iframe), like Shopify's theme thumbnails. */
export function SiteThumb({ url, className }: { url: string; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-lg border bg-muted", className)}>
      <iframe src={url} title="Website preview" loading="lazy" tabIndex={-1} aria-hidden
        className="pointer-events-none absolute left-0 top-0 h-[400%] w-[400%] origin-top-left scale-25 border-0" />
    </div>
  )
}
