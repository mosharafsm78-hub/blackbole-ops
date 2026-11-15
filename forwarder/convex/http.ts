// BlackBole Ops moved to its own server (VPS). This tiny deployment keeps the OLD cloud address working:
// every call to https://basic-crane-965.convex.site/... (Shopify and Pathao webhooks, WhatsApp, the website's
// COD form / catalog / reviews / order status, Marketing OS feeds, auto-call results) is passed to the VPS
// unchanged — same path, query, method, headers and exact body bytes (so Shopify's HMAC still verifies) —
// and the VPS answer is passed back. It reads no database, so it stays inside Convex's free plan.
import { httpActionGeneric, httpRouter } from "convex/server"

const TARGET = "https://ops-site.216-219-95-184.sslip.io"
const DROP_REQUEST = ["host", "content-length", "connection", "accept-encoding"]
const DROP_RESPONSE = ["content-encoding", "content-length", "transfer-encoding", "connection"]

const forward = httpActionGeneric(async (_ctx, req) => {
  const u = new URL(req.url)
  const headers = new Headers(req.headers)
  for (const h of DROP_REQUEST) headers.delete(h)
  headers.set("x-forwarded-by", "convex-cloud-forwarder")
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()
  try {
    const r = await fetch(TARGET + u.pathname + u.search, { method: req.method, headers, body, redirect: "manual" })
    const out = new Headers(r.headers)
    for (const h of DROP_RESPONSE) out.delete(h)
    // 101/204/205/304 answers must not carry a body (a browser's CORS check gets a 204): sending one made Response() throw
    const noBody = r.status === 101 || r.status === 204 || r.status === 205 || r.status === 304
    return new Response(noBody ? null : await r.arrayBuffer(), { status: r.status, headers: out })
  } catch (e) {
    return new Response(JSON.stringify({ error: "BlackBole server not reachable, please retry" }), { status: 502, headers: { "content-type": "application/json" } })
  }
})

const http = httpRouter()
for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
  http.route({ pathPrefix: "/", method, handler: forward })
}
export default http
