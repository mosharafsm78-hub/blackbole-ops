"use node"
// Pathao HTTP calls. Convex's servers can't resolve courier-api.pathao.com, so when
// PATHAO_PROXY_URL is set the call goes through the app's Vercel proxy (Singapore).
import { v } from "convex/values"
import { internalAction } from "./_generated/server"

export const request = internalAction({
  args: { url: v.string(), method: v.string(), headers: v.any(), body: v.optional(v.string()) },
  handler: async (_ctx, { url, method, headers, body }): Promise<{ status: number; text: string }> => {
    const proxy = process.env.PATHAO_PROXY_URL
    const secret = process.env.PATHAO_PROXY_SECRET
    try {
      if (proxy && secret) {
        const res = await fetch(proxy, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-proxy-key": secret },
          body: JSON.stringify({ url, method, headers, body }),
        })
        const data: any = await res.json().catch(() => ({}))
        if (!res.ok || data.error) throw new Error(data.error ?? `proxy HTTP ${res.status}`)
        return { status: data.status, text: data.text }
      }
      const res = await fetch(url, { method, headers, body })
      return { status: res.status, text: await res.text() }
    } catch (e: any) {
      const cause = e?.cause ? ` (${e.cause.code ?? ""} ${e.cause.message ?? e.cause})` : ""
      throw new Error(`Could not reach Pathao: ${e?.message ?? e}${cause}`)
    }
  },
})
