import { useEffect } from 'react'
import type { ErrorComponentProps } from '@tanstack/react-router'

// After a new deploy, an open tab can ask for old code files that no longer exist.
// Reload once to pick up the new version instead of showing an error.
const isStaleBuild = (m: string) => /dynamically imported module|Importing a module script failed|error loading dynamically|reading 'component'|Failed to fetch/i.test(m)
export function reloadForNewVersion() {
  try {
    const last = Number(sessionStorage.getItem('bb-reloaded-at') || 0)
    if (Date.now() - last < 30000) return false
    sessionStorage.setItem('bb-reloaded-at', String(Date.now()))
  } catch { /* storage may be blocked; reload anyway */ }
  window.location.reload()
  return true
}
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (e) => { e.preventDefault(); reloadForNewVersion() })
}

// Wired as router-level `defaultErrorComponent` (see ../router.tsx). Receives
// `{ error, info, reset }` — we only use `error` here.
//
// Retry uses `router.invalidate()`, NOT the `reset` prop. `reset()` alone just
// clears the error boundary without re-running the failed loader, so the same
// error fires again on the next render. `router.invalidate()` re-runs loaders
// AND resets the boundary, which is what you actually want for a retry button.
export function ErrorBoundary({ error }: ErrorComponentProps) {
  // `error` is typed `unknown` — anything can be thrown, not just an Error.
  const message = error instanceof Error ? error.message : String(error)
  const stale = isStaleBuild(message)
  useEffect(() => { if (stale) reloadForNewVersion() }, [stale])
  if (stale) {
    return <div className="flex h-screen items-center justify-center p-6 text-sm text-muted-foreground">Loading the new version…</div>
  }
  return (
    <div className="flex flex-col items-center justify-center h-screen gap-4 p-6 text-center">
      <h1 className="text-4xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground max-w-md break-words">
        {message}
      </p>
      <button
        onClick={() => window.location.reload()}
        className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
      >
        Retry
      </button>
    </div>
  )
}
