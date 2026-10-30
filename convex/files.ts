// Website → Files (Shopify's Content → Files): pictures and videos uploaded for the website (banners, theme images).
// Files live in Convex storage; the website uses their public URL. Deleting a file that a theme still uses makes
// that picture fall back to the theme's built-in one on the next build.
import { v, ConvexError } from "convex/values"
import { action, internalQuery, query, type QueryCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import { internalMutation, mutation } from "./functions"
import { currentStaff } from "./lib"
import { hasPerm } from "./rules"

export const SITE_FILES_URL = "https://blackbole-site.pages.dev/data/files-export.json"
export const MAX_FILE_BYTES = 50 * 1024 * 1024
const OK_TYPE = /^(image\/(jpeg|png|webp|gif|avif|svg\+xml)|video\/(mp4|webm|quicktime))$/

const canManage = (perms: string[]) => hasPerm(perms, "website.manage") || hasPerm(perms, "settings.manage")
async function requireManage(ctx: QueryCtx) {
  const s = await currentStaff(ctx)
  if (!s) throw new ConvexError("You are not signed in or your access was removed.")
  if (!canManage(s.perms)) throw new ConvexError("You don't have permission for this action.")
  return s
}

/** Pictures can also be uploaded by anyone who manages products (the photo on a product). */
async function requireUpload(ctx: QueryCtx) {
  const s = await currentStaff(ctx)
  if (!s) throw new ConvexError("You are not signed in or your access was removed.")
  if (!canManage(s.perms) && !hasPerm(s.perms, "products.manage")) throw new ConvexError("You don't have permission for this action.")
  return s
}

export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUpload(ctx)
    return await ctx.storage.generateUploadUrl()
  },
})

/** Registers an uploaded file and returns its public link. */
export const add = mutation({
  args: { storageId: v.id("_storage"), name: v.string(), type: v.string(), size: v.number(), w: v.optional(v.number()), h: v.optional(v.number()) },
  handler: async (ctx, a) => {
    await requireUpload(ctx)
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
      if (f.storageId) try { await ctx.storage.delete(f.storageId) } catch { /* already gone */ }
      await ctx.db.delete(id)
    }
  },
})

// ---------------- import the pictures the website already has ----------------
const EXT_TYPE: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
}
/** MIME type from a file address (null = not a picture or video). */
export function typeFromUrl(url: string) {
  const ext = (url.split(/[?#]/)[0].split(".").pop() ?? "").toLowerCase()
  return EXT_TYPE[ext] ?? null
}
export type SiteFile = { url: string; name: string; type: string; size: number; w?: number; h?: number }

export const canManageQuery = internalQuery({
  args: {},
  handler: async (ctx) => { const s = await currentStaff(ctx); return !!s && canManage(s.perms) },
})

export const collectionImages = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("webCollections").collect()).map((c) => ({ url: c.image ?? "", title: c.title })).filter((c) => /^https:\/\//.test(c.url)),
})

/** Registers files by link (no upload); skips links already in Files. */
export const registerChunk = internalMutation({
  args: { rows: v.array(v.object({ url: v.string(), name: v.string(), type: v.string(), size: v.number(), w: v.optional(v.number()), h: v.optional(v.number()) })) },
  handler: async (ctx, { rows }) => {
    let added = 0
    for (const r of rows.slice(0, 100)) {
      if (await ctx.db.query("webFiles").withIndex("by_url", (q) => q.eq("url", r.url)).first()) continue
      await ctx.db.insert("webFiles", {
        url: r.url, name: r.name.slice(0, 160) || "file", type: r.type, size: Math.max(0, Math.round(r.size || 0)),
        ...(r.w ? { w: Math.round(r.w) } : {}), ...(r.h ? { h: Math.round(r.h) } : {}), createdAt: Date.now(),
      })
      added++
    }
    return added
  },
})

/** Files → "Import the website's current pictures": theme pictures/videos the website serves (/assets/files/…) and
 *  collection pictures, added to Files by link so the picture picker shows them. Safe to repeat (never duplicates). */
export const importSiteFiles = action({
  args: {},
  handler: async (ctx): Promise<{ found: number; added: number }> => {
    if (!(await ctx.runQuery(internal.files.canManageQuery, {}))) throw new ConvexError("You don't have permission for this action.")
    let list: SiteFile[] = []
    try {
      const res = await fetch(SITE_FILES_URL, { headers: { Accept: "application/json" } })
      if (res.status === 404) throw new Error("the website hasn't published its file list yet, try again in a few minutes")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      const base = new URL(SITE_FILES_URL).origin
      list = (Array.isArray(j?.files) ? j.files : []).map((f: any) => {
        const url = /^https?:\/\//.test(String(f?.url)) ? String(f.url) : base + String(f?.url ?? "")
        return { url, name: String(f?.name ?? url.split("/").pop()), type: typeFromUrl(url) ?? "", size: Number(f?.size) || 0, w: Number(f?.w) || undefined, h: Number(f?.h) || undefined }
      })
    } catch (e: any) {
      throw new ConvexError(`Could not load the website's files (${e?.message ?? "network error"}).`)
    }
    for (const c of await ctx.runQuery(internal.files.collectionImages, {})) {
      const name = decodeURIComponent(c.url.split(/[?#]/)[0].split("/").pop() || c.title)
      list.push({ url: c.url, name, type: typeFromUrl(c.url) ?? "", size: 0 })
    }
    const seen = new Set<string>()
    const rows = list.filter((f) => f.type && OK_TYPE.test(f.type) && !seen.has(f.url) && (seen.add(f.url), true))
      .map((f) => ({ url: f.url, name: f.name, type: f.type, size: f.size, ...(f.w ? { w: f.w } : {}), ...(f.h ? { h: f.h } : {}) }))
    let added = 0
    for (let i = 0; i < rows.length; i += 50) added += await ctx.runMutation(internal.files.registerChunk, { rows: rows.slice(i, i + 50) })
    return { found: rows.length, added }
  },
})
