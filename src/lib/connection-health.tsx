// Keeps Ops from "loading and loading" forever, mostly on phones.
//
// A phone puts a background tab to sleep and its live connection to the database (a websocket) quietly dies, or the
// mobile network drops for a moment. The Convex client reconnects by itself, but until it does every screen just
// says "Loading…" with no way forward except a manual hard refresh. This adds:
//   • SlowHint — after a few seconds on a loading screen, says so and offers a Reload button. On the full-screen
//     loaders (nothing typed there to lose) it also reloads by itself once if there is still no connection.
//   • ConnectionBanner — a small bar while the live connection is down, so the team knows why data isn't updating.
// Automatic reloads are rate-limited (one a minute per tab), so a real outage never turns into a reload loop.
import { useEffect, useState } from "react"
import { useConvex } from "convex/react"

const RELOAD_KEY = "bb-auto-reload-at"
/** Indirection so tests can watch reloads without really reloading. */
export const page = { reload: () => window.location.reload() }
const RELOAD_GAP_MS = 60_000

/** Reload the page unless this tab already did so in the last minute. Returns whether it reloaded. */
export function reloadOnce(): boolean {
  if (typeof window === "undefined") return false
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0)
    if (Date.now() - last < RELOAD_GAP_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch { /* storage blocked: still reload once */ }
  page.reload()
  return true
}

/** Live view of the database connection. `connected` is null until the first reading. */
export function useConnected(): { connected: boolean | null; everConnected: boolean } {
  const convex = useConvex()
  const read = () => {
    try { const s = convex.connectionState(); return { connected: s.isWebSocketConnected, everConnected: s.hasEverConnected } } catch { return { connected: null, everConnected: false } }
  }
  const [state, setState] = useState(read)
  useEffect(() => {
    setState(read())
    try {
      return convex.subscribeToConnectionState((s) => setState({ connected: s.isWebSocketConnected, everConnected: s.hasEverConnected }))
    } catch { return undefined }
  }, [convex]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}

function useSecondsSince(): number {
  const [t, setT] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const id = window.setInterval(() => setT(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [])
  return t
}

/** Shown under a loading screen. After `after` seconds: a short note and a Reload button. With `autoReload` (full-screen
 *  loaders only), reloads once by itself if the database still isn't connected `after + 6` seconds in. */
export function SlowHint({ after = 8, autoReload = false }: { after?: number; autoReload?: boolean }) {
  const secs = useSecondsSince()
  const { connected } = useConnected()
  useEffect(() => {
    if (autoReload && secs >= after + 6 && connected === false) reloadOnce()
  }, [autoReload, secs, after, connected])
  if (secs < after) return null
  return (
    <div className="mt-3 flex flex-col items-center gap-2 text-center text-xs text-muted-foreground" data-testid="slow-hint">
      <p>{connected === false ? "Can't reach the server — your internet may be slow or off." : "Taking longer than usual…"}</p>
      <button type="button" onClick={() => page.reload()} className="rounded-md border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted">Reload</button>
    </div>
  )
}

/** A thin bar at the top while the live connection is down for more than a few seconds (after it had connected once). */
export function ConnectionBanner() {
  const { connected, everConnected } = useConnected()
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (connected !== false || !everConnected) { setShow(false); return }
    const id = window.setTimeout(() => setShow(true), 5000)
    return () => window.clearTimeout(id)
  }, [connected, everConnected])
  if (!show) return null
  return (
    <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 bg-amber-500 px-3 py-1.5 text-xs font-medium text-black" role="status" data-testid="connection-banner">
      <span>Connection lost — reconnecting…</span>
      <button type="button" onClick={() => page.reload()} className="rounded bg-black/10 px-2 py-0.5 hover:bg-black/20">Reload</button>
    </div>
  )
}
