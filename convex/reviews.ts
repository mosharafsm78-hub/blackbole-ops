// Website → Products → Reviews (like Judge.me's admin on Shopify).
// - "Import from Judge.me" reads the reviews Judge.me shows publicly on the old Shopify store (its free widget
//   endpoint, no paid API key) and saves them here. Re-running updates them and never duplicates; hiding a review
//   here is kept across re-imports.
// - Staff publish / hide / delete reviews and write the store reply.
// - The website reads the published ones at build time: GET /website/reviews (X-Feed-Key = MARKETING_FEED_KEY).
// - "Write a review" on the website posts to POST /website/reviews (same key): it arrives as "pending" until a
//   staff member publishes it.
import { v, ConvexError } from "convex/values"
import { action, httpAction, internalAction, internalQuery, query, type ActionCtx, type MutationCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { internalMutation, mutation } from "./functions"
import { currentStaff, getSetting, setSetting } from "./lib"
import { hasPerm } from "./rules"
import { queueRebuild } from "./website"

const canManage = (perms: string[]) => hasPerm(perms, "website.manage") || hasPerm(perms, "settings.manage")

/** The old Shopify store (Judge.me knows the shop by its myshopify domain). */
export const JUDGEME_SHOP = "a88d34-65.myshopify.com"
const JUDGEME_URL = "https://judge.me/reviews/reviews_for_widget"
const PER_PAGE = 50
const UPSERT_CHUNK = 100

/** Shopify products that had Judge.me reviews when the store was exported (id → handle), so reviews of products
 *  that are not (yet) on the new website are imported too. Products on the Website page are added to this. */
export const JUDGEME_PRODUCTS: Record<string, string> = {
  "7813801181321": "mens-waterproof-hiking-shoe-black",
  "7853668434057": "landrover-mens-hiker-casual-sneaker",
  "8229197742217": "mens-heritage-suede-leather-loafer-bb0701",
  "8386440265865": "airflow-pro-max-running-sneakers",
  "8209373528201": "duneflex-lightweight-breathable-slip-on-casual-shoes",
  "8221718380681": "mens-leather-sandal-blackbole-edition-1016",
  "8253915889801": "blackbole-bob-leather-sandal-1018-brown",
  "8209377296521": "trailblaze-trekker-men-s-rugged-outdoor-hiking-shoes",
  "8255459229833": "blackbole-bob-leather-sandal-1018-black",
  "8760395530377": "blackbole-saltway-edge-sandal-for-men-1",
  "8532884291721": "tuscan-crosby-square-leather-sandal-blackbole-edition",
  "8760407031945": "blackbole-harbor-shore-sandal-for-men",
  "8532598849673": "begonia-dualtone-leather-mule-blackbole-edition",
  "8695875600521": "estro-ciabattine-black-leather-mule",
  "8232736424073": "women-waterproof-hiking-boot-black-copy",
  "7940438622345": "mens-high-neck-canvas-sneaker",
  "8283325595785": "cozy-winter-chunky-heeled-boots-with-lace",
  "8834947776649": "blackbole-harbor-shore-sandal-for-men-black-1",
  "8387635314825": "kazimir-sandal-genuine-leather-blackbole-edition",
  "8542755192969": "timberland-nightforge-chukka-boot",
  "7829131362441": "space-motion-studios-ruffle-hem-lantern-sleeve-mock-neck-top-pocket-front-skirt",
  "7860740161673": "shein-prive-solid-cut-out-ruched-bodycon-dress-code-233",
  "7886976254089": "mens-vintage-sports-wrist-waterproof-watch",
  "7873577943177": "men-denim-sneaker-with-golden-strep",
  "7829130608777": "l-mane-brush-print-colorblock-asymmetrical-dress",
  "8721408131209": "jacques-soloviere-biarritz-handcrafted-sandal-black",
  "7944356823177": "high-neck-converse-sports-sneaker",
  "7860732330121": "criss-cross-backless-satin-bodycon-code-231",
  "7829135687817": "classy-fashionable-western-wear-tracksuit-top-bottom-set",
  "8400130769033": "decathlon-kids-bootees-pink",
  "7829164032137": "sxy-ruched-mesh-overlay-fuzzy-trim-tie-backless-halter-bodycon-dress",
}

// ---------------- Judge.me widget HTML → reviews (pure, tested) ----------------
export type ParsedReview = {
  extId: string; handle: string; productTitle: string; rating: number; title: string; body: string; author: string
  location: string; verified: boolean; photos: string[]; reply: string; createdAt: number
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" }
export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENT[e.toLowerCase()] ?? m
  })
}

/** HTML → plain text, paragraphs and <br> kept as new lines. */
export function htmlToText(html: string) {
  const t = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>\s*/gi, "\n")
    .replace(/<[^>]*>/g, "")
  return decodeEntities(t).replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:'([^']*)'|"([^"]*)"|([^\\s>]+))`, "i").exec(tag)
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : ""
}
/** The opening tag of the first element whose class list contains `cls`. */
const openTag = (html: string, cls: string) => {
  const m = new RegExp(`<[a-z]+[^>]*\\sclass\\s*=\\s*['"][^'"]*\\b${cls}\\b[^'"]*['"][^>]*>`, "i").exec(html)
  return m ? { tag: m[0], end: m.index + m[0].length, start: m.index } : null
}
/** Inner HTML of the first element with class `cls` (up to its tag's closing; no same-tag nesting expected). */
const inner = (html: string, cls: string) => {
  const o = openTag(html, cls)
  if (!o) return ""
  const name = /^<([a-z]+)/i.exec(o.tag)![1]
  const close = html.toLowerCase().indexOf(`</${name.toLowerCase()}>`, o.end)
  return close < 0 ? "" : html.slice(o.end, close)
}

/** One page of Judge.me's review widget (the `html` it returns) → reviews. */
export function parseJudgeMeHtml(html: string): ParsedReview[] {
  const starts: number[] = []
  const re = /<div[^>]*\sclass\s*=\s*['"]jdgm-rev(?:\s[^'"]*)?['"][^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) starts.push(m.index)
  const out: ParsedReview[] = []
  starts.forEach((s, i) => {
    const seg = html.slice(s, starts[i + 1] ?? html.length)
    const head = /^<div[^>]*>/i.exec(seg)![0]
    const extId = attr(head, "data-review-id")
    if (!extId) return
    const url = attr(head, "data-product-url")
    const handle = (/\/products\/([^/?#]+)/.exec(url)?.[1] ?? "").toLowerCase()
    const rt = openTag(seg, "jdgm-rev__rating")
    const rating = Math.max(1, Math.min(5, Math.round(Number(rt ? attr(rt.tag, "data-score") : "") || 5)))
    const ts = openTag(seg, "jdgm-rev__timestamp")
    const when = ts ? attr(ts.tag, "datetime") || attr(ts.tag, "data-content").replace(" UTC", "Z").replace(" ", "T") : ""
    const createdAt = Date.parse(when)
    // photos: full-size links first (href), else the image sources; same picture only once
    const picsHtml = (() => {
      const o = openTag(seg, "jdgm-rev__pics")
      if (!o) return ""
      const rest = seg.slice(o.end)
      const stop = rest.search(/class\s*=\s*['"][^'"]*jdgm-rev__(vids|transparency|actions|reply)/i)
      return stop < 0 ? rest : rest.slice(0, stop)
    })()
    const photos: string[] = []
    const seen = new Set<string>()
    const add = (u: string) => {
      if (!u) return
      if (u.startsWith("//")) u = "https:" + u
      if (!/^https:\/\//i.test(u)) return
      const key = u.split("?")[0]
      if (seen.has(key)) return
      seen.add(key)
      photos.push(u)
    }
    for (const t of picsHtml.match(/<a\b[^>]*>/gi) ?? []) add(attr(t, "href") || attr(t, "data-mfp-src"))
    if (!photos.length) for (const t of picsHtml.match(/<img\b[^>]*>/gi) ?? []) add(attr(t, "data-src") || attr(t, "src"))
    out.push({
      extId,
      handle,
      productTitle: attr(head, "data-product-title"),
      rating,
      title: htmlToText(inner(seg, "jdgm-rev__title")),
      body: htmlToText(inner(seg, "jdgm-rev__body")),
      author: htmlToText(inner(seg, "jdgm-rev__author")) || "Anonymous",
      location: htmlToText(inner(seg, "jdgm-rev__location")),
      verified: attr(head, "data-verified-buyer") === "true",
      photos: photos.slice(0, 10),
      reply: htmlToText(inner(seg, "jdgm-rev__reply-content")),
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    })
  })
  return out
}

// ---------------- import ----------------
export const canManageQuery = internalQuery({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    return !!s && canManage(s.perms)
  },
})

export const importTargets = internalQuery({
  args: {},
  handler: async (ctx) => {
    const map: Record<string, string> = { ...JUDGEME_PRODUCTS }
    for (const p of await ctx.db.query("products").collect()) {
      const id = String(p.web?.id ?? "")
      const n = /^gid:\/\/shopify\/Product\/(\d+)$/.exec(id)?.[1]
      if (n && p.handle && !p.deletedAt) map[n] = p.handle
    }
    return map
  },
})

export const upsertImported = internalMutation({
  args: { rows: v.array(v.any()), fallbackHandle: v.string() },
  handler: async (ctx, { rows, fallbackHandle }) => {
    const now = Date.now()
    let added = 0, updated = 0
    for (const r of rows as ParsedReview[]) {
      const data = {
        handle: (r.handle || fallbackHandle).slice(0, 200),
        productTitle: r.productTitle?.slice(0, 200) || undefined,
        rating: r.rating,
        title: r.title?.slice(0, 200) || undefined,
        body: (r.body ?? "").slice(0, 5000),
        author: (r.author || "Anonymous").slice(0, 80),
        location: r.location?.slice(0, 80) || undefined,
        verified: !!r.verified,
        photos: r.photos?.length ? r.photos.slice(0, 10) : undefined,
        reply: r.reply?.slice(0, 3000) || undefined,
        createdAt: r.createdAt || now,
      }
      const old = await ctx.db.query("webReviews").withIndex("by_ext", (q) => q.eq("extId", r.extId)).first()
      if (old) {
        // staff decisions (hidden) and a reply written here stay as they are
        await ctx.db.patch(old._id, { ...data, reply: old.reply || data.reply, updatedAt: now })
        updated++
      } else {
        await ctx.db.insert("webReviews", { ...data, source: "judgeme", extId: r.extId, status: "published", updatedAt: now })
        added++
      }
    }
    return { added, updated }
  },
})

export const finishImport = internalMutation({
  args: { summary: v.any() },
  handler: async (ctx, { summary }) => {
    await setSetting(ctx, "reviewsLastImport", { at: Date.now(), ...summary })
    if (summary.added || summary.updated) await queueRebuild(ctx)
  },
})

type ImportSummary = { products: number; withReviews: number; found: number; added: number; updated: number; photos: number; failed: string[] }

const isJudgeMeUrl = (u: string) => /judge\.?me|imgix\.net/i.test(u)

/** Photos already saved for these Judge.me reviews (extId → photo URLs). */
export const storedPhotos = internalQuery({
  args: { extIds: v.array(v.string()) },
  handler: async (ctx, { extIds }) => {
    const out: Record<string, string[]> = {}
    for (const id of extIds) {
      const r = await ctx.db.query("webReviews").withIndex("by_ext", (q) => q.eq("extId", id)).first()
      if (r?.photos?.length) out[id] = r.photos
    }
    return out
  },
})

async function fetchPage(shop: string, productId: string, page: number) {
  const u = `${JUDGEME_URL}?url=${encodeURIComponent(shop)}&shop_domain=${encodeURIComponent(shop)}&platform=shopify&page=${page}&per_page=${PER_PAGE}&product_id=${productId}`
  let last: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(u, { headers: { Accept: "application/json", "User-Agent": "BlackBole-Ops/1.0 (review import)" } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j: any = await res.json()
      return { html: String(j?.html ?? ""), total: Number(j?.total_count) || 0 }
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, attempt * 1000))
    }
  }
  throw last instanceof Error ? last : new Error("network error")
}

/** Website → Reviews → "Import from Judge.me". */
export const importJudgeMe = action({
  args: { productIds: v.optional(v.array(v.string())) },
  handler: async (ctx, a): Promise<ImportSummary> => {
    if (!(await ctx.runQuery(internal.reviews.canManageQuery, {}))) throw new ConvexError("You don't have permission for this action.")
    return runJudgeMeImport(ctx, a.productIds)
  },
})

/** Same import without a signed-in staff member (run once after deploy: scripts/one-time-resets.json). */
export const importJudgeMeInternal = internalAction({
  args: { productIds: v.optional(v.array(v.string())) },
  handler: async (ctx, a): Promise<ImportSummary> => runJudgeMeImport(ctx, a.productIds),
})

async function runJudgeMeImport(ctx: ActionCtx, productIds?: string[]): Promise<ImportSummary> {
  {
    const targets: Record<string, string> = await ctx.runQuery(internal.reviews.importTargets, {})
    const a = { productIds }
    const ids = a.productIds?.length ? a.productIds.filter((id) => /^\d+$/.test(id)) : Object.keys(targets)
    const sum: ImportSummary = { products: ids.length, withReviews: 0, found: 0, added: 0, updated: 0, photos: 0, failed: [] }
    for (const id of ids) {
      const fallback = targets[id] ?? ""
      try {
        const got: ParsedReview[] = []
        let total = 0
        for (let page = 1; page <= 200; page++) {
          const r = await fetchPage(JUDGEME_SHOP, id, page)
          total = Math.max(total, r.total)
          const rows = parseJudgeMeHtml(r.html)
          if (!rows.length) break
          got.push(...rows)
          if (total && got.length >= total) break
          if (rows.length < PER_PAGE && !total) break
        }
        if (!got.length) continue
        sum.withReviews++
        sum.found += got.length
        // customer photos: keep our own copy (Convex file storage), so they stay after Judge.me/Shopify is closed
        const withPics = got.filter((r) => r.photos.length)
        if (withPics.length) {
          const had: Record<string, string[]> = await ctx.runQuery(internal.reviews.storedPhotos, { extIds: withPics.map((r) => r.extId) })
          for (const r of withPics) {
            const old = had[r.extId]
            if (old?.length && old.every((u) => !isJudgeMeUrl(u))) { r.photos = old; continue }
            const mine: string[] = []
            for (const u of r.photos) {
              try {
                const res = await fetch(u)
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                const blob = await res.blob()
                if (!blob.type.startsWith("image/") || blob.size > 15_000_000) throw new Error("not an image")
                const id = await ctx.storage.store(blob)
                mine.push((await ctx.storage.getUrl(id)) ?? u)
                sum.photos++
              } catch {
                mine.push(u) // keep Judge.me's link; the next import tries again
              }
            }
            r.photos = mine
          }
        }
        for (let i = 0; i < got.length; i += UPSERT_CHUNK) {
          const r = await ctx.runMutation(internal.reviews.upsertImported, { rows: got.slice(i, i + UPSERT_CHUNK), fallbackHandle: fallback })
          sum.added += r.added; sum.updated += r.updated
        }
      } catch (e) {
        sum.failed.push(`${fallback || id}: ${e instanceof Error ? e.message : "error"}`)
      }
    }
    await ctx.runMutation(internal.reviews.finishImport, { summary: sum })
    return sum
  }
}

// ---------------- staff: list + moderate ----------------
export type ReviewRow = {
  _id: Id<"webReviews">; source: string; handle: string; productTitle: string; rating: number; title: string; body: string
  author: string; email: string; location: string; verified: boolean; photos: string[]; reply: string; status: string; createdAt: number
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s || !canManage(s.perms)) return null
    const rows = await ctx.db.query("webReviews").collect()
    // product names from the Website page (fall back to what Judge.me said)
    const titles = new Map<string, string>()
    for (const h of new Set(rows.map((r) => r.handle))) {
      const p = await ctx.db.query("products").withIndex("by_handle", (q) => q.eq("handle", h)).first()
      if (p) titles.set(h, String(p.web?.title || p.name))
    }
    return {
      lastImport: (await getSetting<any>(ctx, "reviewsLastImport")) ?? null,
      reviews: rows.sort((a, b) => b.createdAt - a.createdAt).map((r): ReviewRow => ({
        _id: r._id, source: r.source, handle: r.handle, productTitle: titles.get(r.handle) || r.productTitle || r.handle,
        rating: r.rating, title: r.title ?? "", body: r.body, author: r.author, email: r.email ?? "", location: r.location ?? "",
        verified: !!r.verified, photos: r.photos ?? [], reply: r.reply ?? "", status: r.status, createdAt: r.createdAt,
      })),
    }
  },
})

async function requireManage(ctx: MutationCtx) {
  const s = await currentStaff(ctx)
  if (!s) throw new ConvexError("You are not signed in or your access was removed.")
  if (!canManage(s.perms)) throw new ConvexError("You don't have permission for this action.")
}

const STATUS = v.union(v.literal("published"), v.literal("hidden"))

/** Publish or hide reviews (pending ones become published/hidden too). */
export const setStatus = mutation({
  args: { ids: v.array(v.id("webReviews")), status: STATUS },
  handler: async (ctx, { ids, status }) => {
    await requireManage(ctx)
    let n = 0
    for (const id of ids.slice(0, 2000)) {
      const r = await ctx.db.get(id)
      if (r && r.status !== status) { await ctx.db.patch(id, { status, updatedAt: Date.now() }); n++ }
    }
    if (n) await queueRebuild(ctx)
    return n
  },
})

export const remove = mutation({
  args: { ids: v.array(v.id("webReviews")) },
  handler: async (ctx, { ids }) => {
    await requireManage(ctx)
    let n = 0, live = false
    for (const id of ids.slice(0, 2000)) {
      const r = await ctx.db.get(id)
      if (r) { live ||= r.status === "published"; await ctx.db.delete(id); n++ }
    }
    if (live) await queueRebuild(ctx)
    return n
  },
})

/** The store's public reply under a review (empty removes it). */
export const setReply = mutation({
  args: { id: v.id("webReviews"), reply: v.string() },
  handler: async (ctx, { id, reply }) => {
    await requireManage(ctx)
    const r = await ctx.db.get(id)
    if (!r) throw new ConvexError("This review no longer exists.")
    await ctx.db.patch(id, { reply: reply.trim().slice(0, 3000) || undefined, updatedAt: Date.now() })
    if (r.status === "published") await queueRebuild(ctx)
  },
})

// ---------------- website feed + "Write a review" ----------------
export type FeedReview = {
  id: string; handle: string; rating: number; title: string; body: string; author: string; location: string
  verified: boolean; photos: string[]; reply: string; date: string
}
export function feedReview(r: Doc<"webReviews">): FeedReview {
  return {
    id: r.extId ?? r._id, handle: r.handle, rating: r.rating, title: r.title ?? "", body: r.body, author: r.author,
    location: r.location ?? "", verified: !!r.verified, photos: r.photos ?? [], reply: r.reply ?? "",
    date: new Date(r.createdAt).toISOString(),
  }
}

export const feedData = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("webReviews").withIndex("by_status", (q) => q.eq("status", "published")).collect()
    return rows.sort((a, b) => b.createdAt - a.createdAt).map(feedReview)
  },
})

const WINDOW = 60 * 60 * 1000
const PER_IP = 5 // reviews per IP per hour

export const submit = internalMutation({
  args: { handle: v.string(), rating: v.number(), title: v.string(), body: v.string(), author: v.string(), email: v.string(), ip: v.string() },
  handler: async (ctx, a) => {
    const now = Date.now()
    const key = `review:${a.ip}`
    const rl = await ctx.db.query("rateLimits").withIndex("by_key", (q) => q.eq("key", key)).first()
    if (rl && now - rl.windowStart < WINDOW && rl.count >= PER_IP) return "limited" as const
    if (!rl) await ctx.db.insert("rateLimits", { key, windowStart: now, count: 1 })
    else if (now - rl.windowStart >= WINDOW) await ctx.db.patch(rl._id, { windowStart: now, count: 1 })
    else await ctx.db.patch(rl._id, { count: rl.count + 1 })
    const p = await ctx.db.query("products").withIndex("by_handle", (q) => q.eq("handle", a.handle)).first()
    await ctx.db.insert("webReviews", {
      source: "website", handle: a.handle, productTitle: p ? String(p.web?.title || p.name) : undefined,
      rating: a.rating, title: a.title || undefined, body: a.body, author: a.author, email: a.email || undefined,
      status: "pending", ip: a.ip, createdAt: now, updatedAt: now,
    })
    return "ok" as const
  },
})

/** Checks a review sent from the website; returns an error message or the clean fields. */
export function cleanSubmission(b: any): { error: string } | { handle: string; rating: number; title: string; body: string; author: string; email: string } {
  const s = (x: unknown, n: number) => String(x ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, n)
  const handle = s(b?.handle, 200).toLowerCase()
  const rating = Math.round(Number(b?.rating))
  const author = s(b?.name ?? b?.author, 60)
  const email = s(b?.email, 120).toLowerCase()
  const title = s(b?.title, 120)
  const body = s(b?.body, 3000)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) return { error: "Unknown product" }
  if (!(rating >= 1 && rating <= 5)) return { error: "Please choose a star rating." }
  if (!author) return { error: "Please enter your name." }
  if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return { error: "Please enter a valid email." }
  if (body.length < 3) return { error: "Please write a few words about the product." }
  // links are the usual sign of spam
  if (/https?:\/\/|www\.|<a\s/i.test(body + " " + title + " " + author)) return { error: "Please leave out links." }
  return { handle, rating, title, body, author, email }
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
const feedOk = (req: Request) => { const key = process.env.MARKETING_FEED_KEY; return !!key && key.length >= 24 && req.headers.get("X-Feed-Key") === key }

/** GET: published reviews for the website build. POST: a review written on the website (pending). */
export const reviewsHttp = httpAction(async (ctx, req) => {
  if (!feedOk(req)) return json({ error: "Invalid feed key" }, 401)
  if (req.method === "GET") {
    const reviews = await ctx.runQuery(internal.reviews.feedData, {})
    return json({ reviews, updatedAt: Date.now() })
  }
  let b: any
  try { b = await req.json() } catch { return json({ error: "Bad request" }, 400) }
  const c = cleanSubmission(b)
  if ("error" in c) return json({ ok: false, error: c.error }, 400)
  const ip = String(b?.ip || req.headers.get("X-Client-IP") || "unknown").split(",")[0].trim().slice(0, 64)
  const res = await ctx.runMutation(internal.reviews.submit, { ...c, ip })
  if (res === "limited") return json({ ok: false, error: "Too many reviews from this connection. Please try again later." }, 429)
  return json({ ok: true })
})
