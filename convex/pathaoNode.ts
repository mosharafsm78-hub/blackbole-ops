"use node"
// Pathao HTTP calls run in the Node runtime: the default runtime can't open
// a connection to courier-api.pathao.com.
import { v } from "convex/values"
import { internalAction } from "./_generated/server"

export const request = internalAction({
  args: { url: v.string(), method: v.string(), headers: v.any(), body: v.optional(v.string()) },
  handler: async (_ctx, { url, method, headers, body }): Promise<{ status: number; text: string }> => {
    try {
      const res = await fetch(url, { method, headers, body })
      return { status: res.status, text: await res.text() }
    } catch (e: any) {
      const cause = e?.cause ? ` (${e.cause.code ?? ""} ${e.cause.message ?? e.cause})` : ""
      throw new Error(`Could not reach Pathao: ${e?.message ?? e}${cause}`)
    }
  },
})
