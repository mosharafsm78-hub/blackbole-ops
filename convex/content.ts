// Website content (like Shopify Admin → Online Store): pages, blog posts, navigation menus, URL redirects and store
// settings (announcement bar, delivery charges, contact, social links, homepage, policies, pre-order days).
// The website build reads GET /website/content (X-Feed-Key = MARKETING_FEED_KEY); every save asks for a rebuild
// (same debounced rebuild as products). Nothing here touches orders, stock or prices.
import { v, ConvexError } from "convex/values"
import { action, httpAction, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { internalMutation, mutation } from "./functions"
import { currentStaff, getSetting, setSetting } from "./lib"
import { hasPerm } from "./rules"

export const CONTENT_EXPORT_URL = "https://blackbole-site.pages.dev/data/content-export.json"
const SETTINGS_KEY = "websiteSettings"

const canManage = (perms: string[]) => hasPerm(perms, "website.manage") || hasPerm(perms, "settings.manage")
async function requireManage(ctx: QueryCtx) {
  const s = await currentStaff(ctx)
  if (!s) throw new ConvexError("You are not signed in or your access was removed.")
  if (!canManage(s.perms)) throw new ConvexError("You don't have permission for this action.")
  return s
}
async function allowed(ctx: QueryCtx) {
  const s = await currentStaff(ctx)
  return !!s && canManage(s.perms)
}
const rebuild = (ctx: MutationCtx) => ctx.scheduler.runAfter(0, internal.website.queueRebuildInternal, {})

// ---------------- pure helpers (tested) ----------------
export function slug(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)
}

export type MenuItem = { title: string; url: string; type?: string; items?: MenuItem[] }
/** Cleans a menu tree: trims, drops empty titles, max 3 levels deep, max 60 items per level. */
export function cleanItems(items: unknown, depth = 0): MenuItem[] {
  if (!Array.isArray(items) || depth > 2) return []
  return items.slice(0, 60).map((i: any) => ({
    title: String(i?.title ?? "").trim(),
    url: String(i?.url ?? "").trim() || "#",
    type: String(i?.type ?? "HTTP"),
    items: cleanItems(i?.items, depth + 1),
  })).filter((i) => i.title)
}

/** A redirect "from" must be a site path; "to" a path or full web address. */
export function cleanRedirect(path: string, target: string) {
  let from = path.trim(), to = target.trim()
  try { if (/^https?:\/\//i.test(from)) { const u = new URL(from); from = u.pathname + u.search } } catch { /* keep */ }
  if (!from.startsWith("/")) from = "/" + from
  if (from === "/" ) throw new ConvexError("The old address can't be the home page")
  if (/\s/.test(from)) throw new ConvexError("The old address can't contain spaces")
  if (!to) throw new ConvexError("Enter where it should go")
  if (!/^https?:\/\//i.test(to) && !to.startsWith("/")) to = "/" + to
  if (/\s/.test(to)) throw new ConvexError("The new address can't contain spaces")
  if (from === to) throw new ConvexError("The old and new address are the same")
  return { path: from, target: to }
}

// ---------------- feed for the website build ----------------
// Split into small reads (posts paged 50 at a time) so no single query nears Convex's per-function limits as the blog grows.
export const contentData = internalQuery({
  args: {},
  handler: async (ctx) => {
    const pages = (await ctx.db.query("webPages").collect()).sort((a, b) => a.title.localeCompare(b.title))
    const menus = await ctx.db.query("webMenus").collect()
    const redirects = (await ctx.db.query("webRedirects").collect()).sort((a, b) => a._creationTime - b._creationTime)
    return {
      pages: pages.map((p) => ({ handle: p.handle, title: p.title, body: p.body, isPublished: p.isPublished, publishedAt: p.publishedAt ?? null, templateSuffix: p.templateSuffix ?? null, seo: { title: p.seo?.title ?? "", description: p.seo?.description ?? "" } })),
      menus: menus.map((m) => ({ handle: m.handle, title: m.title, items: m.items })),
      redirects: redirects.map((r) => ({ path: r.path, target: r.target })),
      settings: (await getSetting(ctx, SETTINGS_KEY)) ?? null,
    }
  },
})

export const contentPosts = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const r = await ctx.db.query("webPosts").paginate({ cursor, numItems: 50 })
    return {
      posts: r.page.map((p) => ({ blogHandle: p.blogHandle, blogTitle: p.blogTitle, pos: p.pos, handle: p.handle, title: p.title, body: p.body, summary: p.summary ?? "", tags: p.tags, author: p.author ?? "", image: p.image ?? null, isPublished: p.isPublished, publishedAt: p.publishedAt ?? null, seo: p.seo ?? null })),
      cursor: r.isDone ? null : r.continueCursor,
    }
  },
})

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
export const contentHttp = httpAction(async (ctx, req) => {
  const key = process.env.MARKETING_FEED_KEY
  if (!key || key.length < 24 || req.headers.get("X-Feed-Key") !== key) return json({ error: "Invalid feed key" }, 401)
  const base = await ctx.runQuery(internal.content.contentData, {})
  const posts: any[] = []
  let cursor: string | null = null
  for (let i = 0; i < 200; i++) {
    const r: { posts: any[]; cursor: string | null } = await ctx.runQuery(internal.content.contentPosts, { cursor })
    posts.push(...r.posts)
    cursor = r.cursor
    if (!cursor) break
  }
  posts.sort((a, b) => a.pos - b.pos)
  return json({ ...base, posts, updatedAt: Date.now() })
})

// ---------------- overview (counts for the tabs / empty states) ----------------
export const overview = query({
  args: {},
  handler: async (ctx) => {
    if (!(await allowed(ctx))) return null
    return {
      pages: (await ctx.db.query("webPages").collect()).length,
      posts: (await ctx.db.query("webPosts").collect()).length,
      menus: (await ctx.db.query("webMenus").collect()).length,
      redirects: (await ctx.db.query("webRedirects").collect()).length,
      settings: !!(await getSetting(ctx, SETTINGS_KEY)),
      lastImport: (await getSetting<number>(ctx, "websiteContentImport")) ?? null,
    }
  },
})

// ---------------- pages ----------------
export const pages = query({
  args: {},
  handler: async (ctx) => {
    if (!(await allowed(ctx))) return null
    return (await ctx.db.query("webPages").collect())
      .map((p) => ({ _id: p._id, handle: p.handle, title: p.title, isPublished: p.isPublished, templateSuffix: p.templateSuffix ?? null, updatedAt: p.updatedAt, words: p.body.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length }))
      .sort((a, b) => a.title.localeCompare(b.title))
  },
})

export const page = query({
  args: { id: v.id("webPages") },
  handler: async (ctx, { id }) => ((await allowed(ctx)) ? await ctx.db.get(id) : null),
})

async function uniquePageHandle(ctx: QueryCtx, base: string, self?: Id<"webPages">) {
  const root = slug(base) || "page"
  let h = root, n = 1
  for (;;) {
    const other = await ctx.db.query("webPages").withIndex("by_handle", (q) => q.eq("handle", h)).first()
    if (!other || other._id === self) return h
    h = `${root}-${++n}`
  }
}

export const savePage = mutation({
  args: { id: v.optional(v.id("webPages")), title: v.string(), handle: v.string(), body: v.string(), isPublished: v.boolean(), seo: v.object({ title: v.string(), description: v.string() }) },
  handler: async (ctx, a) => {
    await requireManage(ctx)
    const title = a.title.trim()
    if (!title) throw new ConvexError("Add a title")
    const want = slug(a.handle || title)
    if (a.handle.trim() && !want) throw new ConvexError("The web address needs letters or numbers")
    const clash = await ctx.db.query("webPages").withIndex("by_handle", (q) => q.eq("handle", want)).first()
    if (a.handle.trim() && clash && clash._id !== a.id) throw new ConvexError(`Another page already uses /pages/${want}`)
    const handle = a.handle.trim() ? want : await uniquePageHandle(ctx, title, a.id)
    const prev = a.id ? await ctx.db.get(a.id) : null
    if (a.id && !prev) throw new ConvexError("Page not found")
    const row = {
      handle, title, body: a.body, isPublished: a.isPublished, seo: { title: a.seo.title.trim(), description: a.seo.description.trim() },
      publishedAt: prev?.publishedAt ?? (a.isPublished ? new Date().toISOString() : null), templateSuffix: prev?.templateSuffix ?? null, updatedAt: Date.now(),
    }
    const id = a.id ? (await ctx.db.patch(a.id, row), a.id) : await ctx.db.insert("webPages", row)
    await rebuild(ctx)
    return id
  },
})

export const deletePage = mutation({
  args: { id: v.id("webPages") },
  handler: async (ctx, { id }) => {
    await requireManage(ctx)
    await ctx.db.delete(id)
    await rebuild(ctx)
  },
})

// ---------------- blog ----------------
export const posts = query({
  args: {},
  handler: async (ctx) => {
    if (!(await allowed(ctx))) return null
    const rows = await ctx.db.query("webPosts").collect()
    const blogs = new Map<string, string>()
    for (const p of rows.sort((a, b) => a.pos - b.pos)) if (!blogs.has(p.blogHandle)) blogs.set(p.blogHandle, p.blogTitle)
    return {
      blogs: [...blogs].map(([handle, title]) => ({ handle, title })),
      posts: rows
        .map((p) => ({ _id: p._id, blogHandle: p.blogHandle, blogTitle: p.blogTitle, handle: p.handle, title: p.title, isPublished: p.isPublished, publishedAt: p.publishedAt ?? null, author: p.author ?? "", image: p.image?.url ?? null, updatedAt: p.updatedAt }))
        .sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? ""))),
    }
  },
})

export const post = query({
  args: { id: v.id("webPosts") },
  handler: async (ctx, { id }) => ((await allowed(ctx)) ? await ctx.db.get(id) : null),
})

export const savePost = mutation({
  args: {
    id: v.optional(v.id("webPosts")), blogHandle: v.string(), blogTitle: v.string(), title: v.string(), handle: v.string(), body: v.string(),
    summary: v.string(), tags: v.array(v.string()), author: v.string(), image: v.union(v.null(), v.object({ url: v.string(), altText: v.string(), width: v.union(v.number(), v.null()), height: v.union(v.number(), v.null()) })),
    isPublished: v.boolean(), publishedAt: v.union(v.string(), v.null()), seo: v.object({ title: v.string(), description: v.string() }),
  },
  handler: async (ctx, a) => {
    await requireManage(ctx)
    const title = a.title.trim()
    if (!title) throw new ConvexError("Add a title")
    const blogHandle = slug(a.blogHandle || a.blogTitle) || "news"
    const blogTitle = a.blogTitle.trim() || "News"
    const root = slug(a.handle || title) || "post"
    let handle = root, n = 1
    for (;;) {
      const other = await ctx.db.query("webPosts").withIndex("by_blog_handle", (q) => q.eq("blogHandle", blogHandle).eq("handle", handle)).first()
      if (!other || other._id === a.id) break
      if (a.handle.trim()) throw new ConvexError(`Another post in this blog already uses ${handle}`)
      handle = `${root}-${++n}`
    }
    const prev = a.id ? await ctx.db.get(a.id) : null
    if (a.id && !prev) throw new ConvexError("Post not found")
    const last = prev ? null : (await ctx.db.query("webPosts").collect()).reduce((m, p) => Math.max(m, p.pos), -1)
    const row = {
      blogHandle, blogTitle, handle, title, body: a.body, summary: a.summary.trim(), tags: [...new Set(a.tags.map((t) => t.trim()).filter(Boolean))],
      author: a.author.trim(), image: a.image, isPublished: a.isPublished,
      publishedAt: a.publishedAt || prev?.publishedAt || (a.isPublished ? new Date().toISOString() : null),
      seo: { title: a.seo.title.trim(), description: a.seo.description.trim() }, pos: prev?.pos ?? (last ?? -1) + 1, updatedAt: Date.now(),
    }
    // renaming a blog renames it for every post in it
    if (prev && prev.blogHandle === blogHandle && prev.blogTitle !== blogTitle)
      for (const p of await ctx.db.query("webPosts").collect()) if (p.blogHandle === blogHandle && p._id !== prev._id) await ctx.db.patch(p._id, { blogTitle })
    const id = a.id ? (await ctx.db.patch(a.id, row), a.id) : await ctx.db.insert("webPosts", row)
    await rebuild(ctx)
    return id
  },
})

export const deletePost = mutation({
  args: { id: v.id("webPosts") },
  handler: async (ctx, { id }) => {
    await requireManage(ctx)
    await ctx.db.delete(id)
    await rebuild(ctx)
  },
})

// ---------------- navigation ----------------
export const menus = query({
  args: {},
  handler: async (ctx) => {
    if (!(await allowed(ctx))) return null
    return (await ctx.db.query("webMenus").collect()).map((m) => ({ _id: m._id, handle: m.handle, title: m.title, items: m.items as MenuItem[], updatedAt: m.updatedAt }))
  },
})

export const saveMenu = mutation({
  args: { id: v.optional(v.id("webMenus")), title: v.string(), handle: v.string(), items: v.any() },
  handler: async (ctx, a) => {
    await requireManage(ctx)
    const title = a.title.trim()
    if (!title) throw new ConvexError("Give the menu a name")
    const handle = slug(a.handle || title)
    if (!handle) throw new ConvexError("The menu needs a handle")
    const clash = await ctx.db.query("webMenus").withIndex("by_handle", (q) => q.eq("handle", handle)).first()
    if (clash && clash._id !== a.id) throw new ConvexError(`Another menu already uses the handle ${handle}`)
    const row = { title, handle, items: cleanItems(a.items), updatedAt: Date.now() }
    const id = a.id ? (await ctx.db.patch(a.id, row), a.id) : await ctx.db.insert("webMenus", row)
    await rebuild(ctx)
    return id
  },
})

export const deleteMenu = mutation({
  args: { id: v.id("webMenus") },
  handler: async (ctx, { id }) => {
    await requireManage(ctx)
    await ctx.db.delete(id)
    await rebuild(ctx)
  },
})

/** Everything a menu item can link to (link picker). */
export const linkTargets = query({
  args: {},
  handler: async (ctx) => {
    if (!(await allowed(ctx))) return null
    const products = (await ctx.db.query("products").collect()).filter((p) => p.handle && !p.deletedAt && p.web?.published)
    const colls = await ctx.db.query("webCollections").collect()
    const pages = await ctx.db.query("webPages").collect()
    const posts = await ctx.db.query("webPosts").collect()
    const blogs = new Map<string, string>()
    for (const p of posts) blogs.set(p.blogHandle, p.blogTitle)
    return {
      collections: colls.map((c) => ({ title: c.title, url: `/collections/${c.handle}` })).sort((a, b) => a.title.localeCompare(b.title)),
      products: products.map((p) => ({ title: String(p.web?.title || p.name), url: `/products/${p.handle}` })).sort((a, b) => a.title.localeCompare(b.title)),
      pages: pages.map((p) => ({ title: p.title, url: `/pages/${p.handle}` })).sort((a, b) => a.title.localeCompare(b.title)),
      blogs: [...blogs].map(([h, t]) => ({ title: t, url: `/blogs/${h}` })),
    }
  },
})

// ---------------- URL redirects ----------------
export const redirects = query({
  args: {},
  handler: async (ctx) => {
    if (!(await allowed(ctx))) return null
    return (await ctx.db.query("webRedirects").collect()).sort((a, b) => a.path.localeCompare(b.path)).map((r) => ({ _id: r._id, path: r.path, target: r.target }))
  },
})

export const saveRedirect = mutation({
  args: { id: v.optional(v.id("webRedirects")), path: v.string(), target: v.string() },
  handler: async (ctx, a) => {
    await requireManage(ctx)
    const r = cleanRedirect(a.path, a.target)
    const clash = await ctx.db.query("webRedirects").withIndex("by_path", (q) => q.eq("path", r.path)).first()
    if (clash && clash._id !== a.id) throw new ConvexError(`${r.path} already redirects to ${clash.target}`)
    const id = a.id ? (await ctx.db.patch(a.id, { ...r, updatedAt: Date.now() }), a.id) : await ctx.db.insert("webRedirects", { ...r, updatedAt: Date.now() })
    await rebuild(ctx)
    return id
  },
})

export const deleteRedirect = mutation({
  args: { id: v.id("webRedirects") },
  handler: async (ctx, { id }) => {
    await requireManage(ctx)
    await ctx.db.delete(id)
    await rebuild(ctx)
  },
})

// ---------------- store settings ----------------
export const settings = query({
  args: {},
  handler: async (ctx) => ((await allowed(ctx)) ? ((await getSetting(ctx, SETTINGS_KEY)) ?? null) : null),
})

const settingsV = v.object({
  announcements: v.array(v.string()),
  delivery: v.object({ inside: v.number(), outside: v.number() }),
  preOrderDays: v.string(),
  contact: v.object({ phone: v.string(), whatsapp: v.string(), email: v.string() }),
  social: v.object({ facebook: v.string(), instagram: v.string(), tiktok: v.string(), youtube: v.string() }),
  home: v.object({
    seoTitle: v.string(), seoDescription: v.string(), heroKicker: v.string(), heroTitle: v.string(), heroButton: v.string(), heroLink: v.string(),
    newCollection: v.string(), bestCollection: v.string(), store1Address: v.string(), store2Address: v.string(), hours: v.string(),
  }),
  policies: v.array(v.object({ type: v.string(), title: v.string(), body: v.string() })),
})

export const saveSettings = mutation({
  args: { settings: settingsV },
  handler: async (ctx, { settings: s }) => {
    await requireManage(ctx)
    for (const k of ["inside", "outside"] as const) {
      const n = s.delivery[k]
      if (!(Number.isFinite(n) && n >= 0 && n <= 2000)) throw new ConvexError("Delivery charges must be between ৳0 and ৳2,000")
    }
    const wa = s.contact.whatsapp.replace(/[^\d]/g, "")
    if (s.contact.whatsapp && !/^8801\d{9}$/.test(wa)) throw new ConvexError("WhatsApp number must look like 8801XXXXXXXXX")
    if (s.contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.contact.email.trim())) throw new ConvexError("The email address doesn't look right")
    await setSetting(ctx, SETTINGS_KEY, {
      ...s,
      announcements: s.announcements.map((m) => m.trim()).filter(Boolean).slice(0, 8),
      delivery: { inside: Math.round(s.delivery.inside), outside: Math.round(s.delivery.outside) },
      contact: { phone: s.contact.phone.trim(), whatsapp: wa, email: s.contact.email.trim() },
    })
    await rebuild(ctx)
  },
})

// ---------------- import from the current website (one-time copy, safe to repeat) ----------------
export const importChunk = internalMutation({
  args: { kind: v.union(v.literal("pages"), v.literal("posts"), v.literal("menus"), v.literal("redirects"), v.literal("settings")), rows: v.any() },
  handler: async (ctx, { kind, rows }) => {
    const now = Date.now()
    let n = 0
    if (kind === "settings") {
      if (rows && typeof rows === "object" && !(await getSetting(ctx, SETTINGS_KEY))) { await setSetting(ctx, SETTINGS_KEY, rows); n = 1 }
      return n
    }
    for (const r of Array.isArray(rows) ? rows : []) {
      if (kind === "pages") {
        if (!r?.handle) continue
        const row = { handle: String(r.handle), title: String(r.title ?? r.handle), body: String(r.body ?? ""), isPublished: r.isPublished !== false, publishedAt: r.publishedAt ?? null, templateSuffix: r.templateSuffix ?? null, seo: { title: r.seo?.title ?? "", description: r.seo?.description ?? "" }, updatedAt: now }
        const cur = await ctx.db.query("webPages").withIndex("by_handle", (q) => q.eq("handle", row.handle)).first()
        if (cur) await ctx.db.patch(cur._id, row); else await ctx.db.insert("webPages", row)
      } else if (kind === "posts") {
        if (!r?.handle || !r?.blogHandle) continue
        const row = { blogHandle: String(r.blogHandle), blogTitle: String(r.blogTitle ?? r.blogHandle), handle: String(r.handle), title: String(r.title ?? r.handle), body: String(r.body ?? ""), summary: String(r.summary ?? ""), tags: Array.isArray(r.tags) ? r.tags.map(String) : [], author: String(r.author ?? ""), image: r.image ?? null, isPublished: r.isPublished !== false, publishedAt: r.publishedAt ?? null, seo: r.seo ?? null, pos: Number(r.pos) || 0, updatedAt: now }
        const cur = await ctx.db.query("webPosts").withIndex("by_blog_handle", (q) => q.eq("blogHandle", row.blogHandle).eq("handle", row.handle)).first()
        if (cur) await ctx.db.patch(cur._id, row); else await ctx.db.insert("webPosts", row)
      } else if (kind === "menus") {
        if (!r?.handle) continue
        const row = { handle: String(r.handle), title: String(r.title ?? r.handle), items: cleanItems(r.items), updatedAt: now }
        const cur = await ctx.db.query("webMenus").withIndex("by_handle", (q) => q.eq("handle", row.handle)).first()
        if (cur) await ctx.db.patch(cur._id, row); else await ctx.db.insert("webMenus", row)
      } else if (kind === "redirects") {
        if (!r?.path || !r?.target) continue
        const row = { path: String(r.path), target: String(r.target), updatedAt: now }
        const cur = await ctx.db.query("webRedirects").withIndex("by_path", (q) => q.eq("path", row.path)).first()
        if (cur) await ctx.db.patch(cur._id, row); else await ctx.db.insert("webRedirects", row)
      }
      n++
    }
    return n
  },
})

export const finishImport = internalMutation({
  args: {},
  handler: async (ctx) => {
    await setSetting(ctx, "websiteContentImport", Date.now())
    await rebuild(ctx)
  },
})

export const canManageQuery = internalQuery({ args: {}, handler: async (ctx) => allowed(ctx) })

/** Copies pages, blog posts, menus, redirects and settings from the live website into Ops (updates by handle,
 *  never duplicates; settings only when none are saved yet). */
export const importContent = action({
  args: { what: v.union(v.literal("all"), v.literal("pages"), v.literal("posts"), v.literal("menus"), v.literal("redirects"), v.literal("settings")) },
  handler: async (ctx, { what }) => {
    if (!(await ctx.runQuery(internal.content.canManageQuery, {}))) throw new ConvexError("You don't have permission for this action.")
    let data: any
    try {
      const res = await fetch(CONTENT_EXPORT_URL, { headers: { Accept: "application/json" } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      data = await res.json()
    } catch (e: any) {
      throw new ConvexError(`Could not load the website's content (${e?.message ?? "network error"}).`)
    }
    const out: Record<string, number> = {}
    for (const kind of ["pages", "posts", "menus", "redirects", "settings"] as const) {
      if (what !== "all" && what !== kind) continue
      const rows = data?.[kind]
      if (kind === "settings") { out.settings = await ctx.runMutation(internal.content.importChunk, { kind, rows }); continue }
      const list: any[] = Array.isArray(rows) ? rows : []
      out[kind] = 0
      for (let i = 0; i < list.length; i += 10) out[kind] += await ctx.runMutation(internal.content.importChunk, { kind, rows: list.slice(i, i + 10) })
    }
    await ctx.runMutation(internal.content.finishImport, {})
    return out
  },
})
