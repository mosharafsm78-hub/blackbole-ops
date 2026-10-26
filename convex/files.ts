// Website → Files (Shopify's Content → Files): pictures and videos uploaded for the website (banners, theme images).
// Files live in Convex storage; the website uses their public URL. Deleting a file that a theme still uses makes
// that picture fall back to the theme's built-in one on the next build.
import { v, ConvexError } from "convex/values"
import { query, type QueryCtx } from "./_generated/server"
import { mutation } from "./functions"
import { currentStaff } from "./lib"
import { hasPerm } from "./rules"

export const MAX_FILE_BYTES = 50 * 1024 * 1024
const OK_TYPE = /^(image\/(jpeg|png|webp|gif|avif|svg\+xml)|video\/(mp4|webm|quicktime))$/

const canManage = (perms: string[]) => hasPerm(perms, "website.manage") || hasPerm(perms, "settings.manage")
async function requireManage(ctx: QueryCtx) {
  const s = await currentStaff(ctx)
  if (!s) throw new ConvexError("You are not signed in or your access was removed.")
  if (!canManage(s.perms)) throw new ConvexError("You don't have permission for this action.")
  return s
}

export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireManage(ctx)
    return await ctx.storage.generateUploadUrl()
  },
})

/** Registers an uploaded file and returns its public link. */
export const add = mutation({
  args: { storageId: v.id("_storage"), name: v.string(), type: v.string(), size: v.number(), w: v.optional(v.number()), h: v.optional(v.number()) },
  handler: async (ctx, a) => {
    await requireManage(ctx)
    const type = a.type.toLowerCase()
    if (!OK_TYPE.test(type)) { await ctx.storage.delete(a.storageId); throw new ConvexError("Only pictures (JPG, PNG, WebP, GIF, AVIF, SVG) and videos (MP4, WebM, MOV) can be uploaded.") }
    if (a.size > MAX_FILE_BYTES) { await ctx.storage.delete(a.storageId); throw new ConvexError("Files can be up to 50 MB.") }
    const url = await ctx.storage.getUrl(a.storageId)
    if (!url) throw new ConvexError("Upload not found")
    const name = a.name.trim().slice(0, 160) || "file"
    const id = await ctx.db.insert("webFiles", {
      storageId: a.storageId, url, name, type, size: a.size,
      ...(a.w ? { w: Math.round(a.w) } : {}), ...(a.h ? { h: Math.round(a.h) } : {}), createdAt: Date.now(),
    })
    return { id, url }
  },
})

export const list = query({
  args: { q: v.optional(v.string()), kind: v.optional(v.union(v.literal("all"), v.literal("image"), v.literal("video"))) },
  handler: async (ctx, { q, kind }) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const rows = await ctx.db.query("webFiles").withIndex("by_created").order("desc").take(1000)
    const term = (q ?? "").trim().toLowerCase()
    return rows
      .filter((f) => (!kind || kind === "all" || f.type.startsWith(kind + "/")) && (!term || f.name.toLowerCase().includes(term) || (f.alt ?? "").toLowerCase().includes(term)))
      .map((f) => ({ _id: f._id, url: f.url, name: f.name, type: f.type, size: f.size, w: f.w ?? null, h: f.h ?? null, alt: f.alt ?? "", createdAt: f.createdAt }))
  },
})

export const update = mutation({
  args: { id: v.id("webFiles"), name: v.optional(v.string()), alt: v.optional(v.string()) },
  handler: async (ctx, { id, name, alt }) => {
    await requireManage(ctx)
    const f = await ctx.db.get(id)
    if (!f) throw new ConvexError("This file was deleted.")
    await ctx.db.patch(id, {
      ...(name !== undefined && name.trim() ? { name: name.trim().slice(0, 160) } : {}),
      ...(alt !== undefined ? { alt: alt.trim().slice(0, 300) } : {}),
    })
  },
})

export const remove = mutation({
  args: { ids: v.array(v.id("webFiles")) },
  handler: async (ctx, { ids }) => {
    await requireManage(ctx)
    for (const id of ids.slice(0, 200)) {
      const f = await ctx.db.get(id)
      if (!f) continue
      try { await ctx.storage.delete(f.storageId) } catch { /* already gone */ }
      await ctx.db.delete(id)
    }
  },
})
