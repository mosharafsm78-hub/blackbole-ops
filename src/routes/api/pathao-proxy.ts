import { createFileRoute } from "@tanstack/react-router"
import { PROXY_SECRET } from "@/server/proxy-secret"

// Convex's servers can't resolve Pathao's API host, so Convex sends Pathao calls
// here (Vercel, Singapore) and this forwards them. Only Pathao hosts are allowed.
const ALLOWED = ["https://merchant.pathao.com/api/v1/address-parser", "https://api-hermes.pathao.com/", "https://courier-api.pathao.com/", "https://courier-api-sandbox.pathao.com/"]

export const Route = createFileRoute("/api/pathao-proxy")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (PROXY_SECRET.startsWith("__") || request.headers.get("x-proxy-key") !== PROXY_SECRET) {
          return new Response("forbidden", { status: 403 })
        }
        const { url, method, headers, body } = (await request.json()) as { url: string; method: string; headers: Record<string, string>; body?: string }
        if (!ALLOWED.some((p) => url.startsWith(p))) return new Response("host not allowed", { status: 400 })
        try {
          const res = await fetch(url, { method, headers, body })
          return Response.json({ status: res.status, text: await res.text() })
        } catch (e: any) {
          return Response.json({ error: `${e?.message ?? e}${e?.cause ? ` (${e.cause.code ?? ""} ${e.cause.message ?? ""})` : ""}` }, { status: 502 })
        }
      },
    },
  },
})
