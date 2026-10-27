// Vite dispatches `vite:preloadError` on `window` whenever a dynamically-imported chunk (a lazy route, a
// lazy-loaded dialog, etc.) fails to load — this happens whenever a browser tab has the app open and a new
// deploy replaces the hashed asset files underneath it, or a transient CDN/edge hiccup 503s a single chunk
// (Vercel can briefly do this right after a push, especially with several deploys landing back to back).
//
// Without this, the app is stuck forever on the splash screen with no way forward except a manual hard
// refresh — the failed import just silently kills app startup. One automatic reload, guarded so it can only
// fire once per tab (never an infinite reload loop if the asset is genuinely gone), fixes it transparently.
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault()
    const key = 'bb-reloaded-after-chunk-error'
    if (sessionStorage.getItem(key)) return // already tried once this session — stop here instead of looping
    sessionStorage.setItem(key, '1')
    window.location.reload()
  })
}
