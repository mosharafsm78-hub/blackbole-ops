// Website → Themes (Shopify's Online Store → Themes).
//
//  live      what blackbole.com shows. Changed only by Publish or Roll back.
//  draft     what the preview site (Cloudflare branch "draft") shows. Edited in Customize; every save rebuilds only
//            the preview (env WEBSITE_DRAFT_HOOK, ~45 s grouping), so the live site can never break from an edit.
//  archived  earlier live themes (newest 10 kept) — Roll back puts one live again.
//
// The website reads GET /website/theme?which=live|draft at build time (X-Feed-Key = MARKETING_FEED_KEY).
// Theme data is { settings, templates } — the same shape as the website's src/data/theme.json.
import { v, ConvexError } from "convex/values"
import { action, httpAction, internalAction, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { internalMutation, mutation } from "./functions"
import { currentStaff, getSetting, setSetting } from "./lib"
import { hasPerm } from "./rules"
import { queueRebuild } from "./website"

export const THEME_EXPORT_URL = "https://blackbole-site.pages.dev/data/theme-export.json"
export const KEEP_ARCHIVED = 10
const MAX_BYTES = 700_000
const DRAFT_DELAY = 45 * 1000

const canManage = (perms: string[]) => hasPerm(perms, "website.manage") || hasPerm(perms, "settings.manage")
async function requireManage(ctx: QueryCtx) {
  const s = await currentStaff(ctx)
  if (!s) throw new ConvexError("You are not signed in or your access was removed.")
  if (!canManage(s.perms)) throw new ConvexError("You don't have permission for this action.")
  return s
}

// ---------------- helpers (pure, tested) ----------------
/** Checks theme data and returns it as compact JSON text. Throws a readable error when it isn't a usable theme. */
export function cleanThemeJson(input: unknown): string {
  let d: any = input
  if (typeof d === "string") {
    try { d = JSON.parse(d) } catch { throw new ConvexError("The theme data is not valid.") }
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new ConvexError("The theme data is not valid.")
  const { settings, templates } = d
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new ConvexError("The theme has no settings.")
  if (!templates || typeof templates !== "object" || Array.isArray(templates)) throw new ConvexError("The theme has no page templates.")
  if (!templates.index || !templates.product) throw new ConvexError("The theme is missing the home page or product page.")
  const text = JSON.stringify({ settings, templates })
  if (text.length > MAX_BYTES) throw new ConvexError("The theme is too large.")
  return text
}

const byRole = (ctx: QueryCtx, role: "live" | "draft" | "archived") => ctx.db.query("webThemes").withIndex("by_role", (q) => q.eq("role", role))

async function staffName(ctx: QueryCtx) {
  const s = await currentStaff(ctx)
  return s?.staff.name ?? "Someone"
}

/** Keep only the newest KEEP_ARCHIVED archived themes. */
async function trimArchived(ctx: MutationCtx) {
  const list = (await byRole(ctx, "archived").collect()).sort((a, b) => (b.publishedAt ?? b.updatedAt) - (a.publishedAt ?? a.updatedAt))
  for (const t of list.slice(KEEP_ARCHIVED)) await ctx.db.delete(t._id)
}

// ---------------- preview (draft) rebuild, debounced ----------------
type DraftState = { due: number; pending: boolean; queuedAt?: number }

export async function queueDraftBuild(ctx: MutationCtx) {
  const now = Date.now()
  const cur = await getSetting<DraftState>(ctx, "themeDraftBuild")
  const stuck = cur?.pending && cur.due < now - 10 * 60 * 1000
  await setSetting(ctx, "themeDraftBuild", { due: now + DRAFT_DELAY, pending: true, queuedAt: now })
  if (!cur?.pending || stuck) await ctx.scheduler.runAfter(DRAFT_DELAY, internal.themes.draftTick, {})
}

export const draftTick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const r = await getSetting<DraftState>(ctx, "themeDraftBuild")
    if (!r?.pending) return
    const wait = r.due - Date.now()
    if (wait > 1000) { await ctx.scheduler.runAfter(wait, internal.themes.draftTick, {}); return }
    await setSetting(ctx, "themeDraftBuild", { ...r, pending: false })
    await ctx.scheduler.runAfter(0, internal.themes.draftHook, {})
  },
})

export const draftHook = internalAction({
  args: {},
  handler: async (ctx) => {
    const url = process.env.WEBSITE_DRAFT_HOOK
    if (!url) return
    let ok = false, status = 0
    try {
      const res = await fetch(url, { method: "POST" })
      ok = res.ok
      status = res.status
    } catch { ok = false }
    await ctx.runMutation(internal.themes.recordDraftBuild, { ok, status })
  },
})

export const recordDraftBuild = internalMutation({
  args: { ok: v.boolean(), status: v.number() },
  handler: async (ctx, a) => { await setSetting(ctx, "themeDraftLastBuild", { at: Date.now(), ok: a.ok, status: a.status }) },
})

// ---------------- reads ----------------
export const overview = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const rows = await ctx.db.query("webThemes").collect()
    const meta = (t: Doc<"webThemes">) => ({ _id: t._id, name: t.name, role: t.role, updatedAt: t.updatedAt, updatedBy: t.updatedBy ?? null, publishedAt: t.publishedAt ?? null, publishedBy: t.publishedBy ?? null })
    return {
      live: rows.find((t) => t.role === "live") ? meta(rows.find((t) => t.role === "live")!) : null,
      draft: rows.find((t) => t.role === "draft") ? meta(rows.find((t) => t.role === "draft")!) : null,
      archived: rows.filter((t) => t.role === "archived").sort((a, b) => (b.publishedAt ?? b.updatedAt) - (a.publishedAt ?? a.updatedAt)).map(meta),
      draftHook: !!process.env.WEBSITE_DRAFT_HOOK,
      liveHook: !!process.env.WEBSITE_DEPLOY_HOOK,
      draftBuild: (await getSetting<DraftState>(ctx, "themeDraftBuild")) ?? null,
      draftLastBuild: (await getSetting<{ at: number; ok: boolean; status: number }>(ctx, "themeDraftLastBuild")) ?? null,
      liveBuild: (await getSetting<any>(ctx, "websiteRebuild")) ?? null,
      liveLastBuild: (await getSetting<{ at: number; ok: boolean; status: number }>(ctx, "websiteLastBuild")) ?? null,
    }
  },
})

export const get = query({
  args: { id: v.id("webThemes") },
  handler: async (ctx, { id }) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const t = await ctx.db.get(id)
    if (!t) return null
    return { _id: t._id, name: t.name, role: t.role, updatedAt: t.updatedAt, updatedBy: t.updatedBy ?? null, data: JSON.parse(t.json) }
  },
})

// ---------------- import ----------------
export const canManageQuery = internalQuery({ args: {}, handler: async (ctx) => { const s = await currentStaff(ctx); return !!s && canManage(s.perms) } })

/** Copies the theme the website shows today into Ops: it becomes the Live theme, plus a Draft copy to edit. */
export const importCurrent = action({
  args: {},
  handler: async (ctx): Promise<{ ok: true }> => {
    if (!(await ctx.runQuery(internal.themes.canManageQuery, {}))) throw new ConvexError("You don't have permission for this action.")
    let data: any
    try {
      const res = await fetch(THEME_EXPORT_URL, { headers: { Accept: "application/json" } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      data = await res.json()
    } catch (e: any) {
      throw new ConvexError(`Could not load the website's theme (${e?.message ?? "network error"}).`)
    }
    await ctx.runMutation(internal.themes.importTheme, { json: cleanThemeJson(data) })
    return { ok: true }
  },
})

export const importTheme = internalMutation({
  args: { json: v.string() },
  handler: async (ctx, { json }) => {
    if (await byRole(ctx, "live").first()) throw new ConvexError("The theme is already in Ops.")
    const now = Date.now()
    const by = await staffName(ctx)
    await ctx.db.insert("webThemes", { name: "BlackBole 2026", role: "live", json, updatedAt: now, updatedBy: by, publishedAt: now, publishedBy: by })
    for (const d of await byRole(ctx, "draft").collect()) await ctx.db.delete(d._id)
    await ctx.db.insert("webThemes", { name: "BlackBole 2026 (draft)", role: "draft", json, updatedAt: now, updatedBy: by })
    await queueDraftBuild(ctx)
  },
})

// ---------------- edits ----------------
/** Saves the draft theme. Only the preview site rebuilds; blackbole.com doesn't change until Publish. */
export const saveDraft = mutation({
  args: { id: v.id("webThemes"), data: v.string(), updatedAt: v.optional(v.number()) },
  handler: async (ctx, { id, data, updatedAt }) => {
    const s = await requireManage(ctx)
    const t = await ctx.db.get(id)
    if (!t) throw new ConvexError("This theme was deleted.")
    if (t.role !== "draft") throw new ConvexError("Only the draft theme can be edited. Copy this theme to the draft first.")
    if (updatedAt && t.updatedAt > updatedAt && t.updatedBy && t.updatedBy !== s.staff.name)
      throw new ConvexError(`${t.updatedBy} saved this draft after you opened it. Reload to see their changes.`)
    const json = cleanThemeJson(data)
    const now = Date.now()
    await ctx.db.patch(id, { json, updatedAt: now, updatedBy: s.staff.name })
    await queueDraftBuild(ctx)
    return { updatedAt: now }
  },
})

/** Puts the draft live: the live theme is archived, the draft becomes live, and a fresh draft copy is made. */
export const publish = mutation({
  args: { id: v.id("webThemes") },
  handler: async (ctx, { id }) => {
    const s = await requireManage(ctx)
    const d = await ctx.db.get(id)
    if (!d || d.role !== "draft") throw new ConvexError("Only the draft theme can be published.")
    cleanThemeJson(d.json)
    const now = Date.now()
    for (const live of await byRole(ctx, "live").collect()) await ctx.db.patch(live._id, { role: "archived" })
    const name = d.name.replace(/\s*\(draft\)$/i, "") || "Theme"
    await ctx.db.patch(id, { role: "live", name, publishedAt: now, publishedBy: s.staff.name })
    await ctx.db.insert("webThemes", { name: `${name} (draft)`, role: "draft", json: d.json, updatedAt: now, updatedBy: s.staff.name })
    await trimArchived(ctx)
    await queueRebuild(ctx)
    return { ok: true }
  },
})

/** Puts an earlier theme live again (default: the one live just before). The current live theme is archived. */
export const rollback = mutation({
  args: { id: v.optional(v.id("webThemes")) },
  handler: async (ctx, { id }) => {
    const s = await requireManage(ctx)
    const archived = (await byRole(ctx, "archived").collect()).sort((a, b) => (b.publishedAt ?? b.updatedAt) - (a.publishedAt ?? a.updatedAt))
    const target = id ? archived.find((t) => t._id === id) : archived[0]
    if (!target) throw new ConvexError("There is no earlier theme to go back to.")
    const now = Date.now()
    for (const live of await byRole(ctx, "live").collect()) await ctx.db.patch(live._id, { role: "archived" })
    await ctx.db.patch(target._id, { role: "live", publishedAt: now, publishedBy: s.staff.name })
    await trimArchived(ctx)
    await queueRebuild(ctx)
    return { name: target.name }
  },
})

/** Makes a theme (live or archived) the new draft. The current draft is kept in the archive. */
export const copyToDraft = mutation({
  args: { id: v.id("webThemes") },
  handler: async (ctx, { id }) => {
    const s = await requireManage(ctx)
    const src = await ctx.db.get(id)
    if (!src) throw new ConvexError("This theme was deleted.")
    if (src.role === "draft") return { id }
    const now = Date.now()
    for (const d of await byRole(ctx, "draft").collect()) await ctx.db.patch(d._id, { role: "archived", name: `${d.name.replace(/\s*\(draft\)$/i, "")} (old draft)` })
    const nid = await ctx.db.insert("webThemes", { name: `${src.name.replace(/\s*\((old )?draft\)$/i, "")} (draft)`, role: "draft", json: src.json, updatedAt: now, updatedBy: s.staff.name })
    await trimArchived(ctx)
    await queueDraftBuild(ctx)
    return { id: nid }
  },
})

export const rename = mutation({
  args: { id: v.id("webThemes"), name: v.string() },
  handler: async (ctx, { id, name }) => {
    await requireManage(ctx)
    const n = name.trim().slice(0, 80)
    if (!n) throw new ConvexError("Give the theme a name.")
    if (!(await ctx.db.get(id))) throw new ConvexError("This theme was deleted.")
    await ctx.db.patch(id, { name: n })
  },
})

export const remove = mutation({
  args: { id: v.id("webThemes") },
  handler: async (ctx, { id }) => {
    await requireManage(ctx)
    const t = await ctx.db.get(id)
    if (!t) return
    if (t.role !== "archived") throw new ConvexError("Only an archived theme can be deleted.")
    await ctx.db.delete(id)
  },
})

/** Rebuild the preview site now (e.g. after the preview hook was set up). */
export const rebuildPreview = mutation({
  args: {},
  handler: async (ctx) => {
    await requireManage(ctx)
    await setSetting(ctx, "themeDraftBuild", { due: Date.now(), pending: false })
    await ctx.scheduler.runAfter(0, internal.themes.draftHook, {})
    return { hook: !!process.env.WEBSITE_DRAFT_HOOK }
  },
})

// ---------------- feed for the website build ----------------
export const feedData = internalQuery({
  args: { which: v.union(v.literal("live"), v.literal("draft")) },
  handler: async (ctx, { which }) => {
    const t = (which === "draft" ? await byRole(ctx, "draft").first() : null) ?? (await byRole(ctx, "live").first())
    if (!t) return { theme: null }
    return { name: t.name, role: t.role, updatedAt: t.updatedAt, json: t.json }
  },
})

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })

export const themeHttp = httpAction(async (ctx, req) => {
  const key = process.env.MARKETING_FEED_KEY
  if (!key || key.length < 24 || req.headers.get("X-Feed-Key") !== key) return json({ error: "Invalid feed key" }, 401)
  const which = new URL(req.url).searchParams.get("which") === "draft" ? "draft" : "live"
  const r: any = await ctx.runQuery(internal.themes.feedData, { which })
  if (!r.json) return json({ theme: null })
  // the stored text is already a checked { settings, templates } object; send it without re-parsing
  return new Response(`{"name":${JSON.stringify(r.name)},"role":${JSON.stringify(r.role)},"updatedAt":${r.updatedAt},"theme":${r.json}}`, {
    status: 200, headers: { "Content-Type": "application/json" },
  })
})

export type ThemeId = Id<"webThemes">
