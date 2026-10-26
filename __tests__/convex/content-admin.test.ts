import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api } from "../../convex/_generated/api"
import { isLive, nextPublishedAt } from "../../convex/content"
import { SITE_FILES_URL, typeFromUrl } from "../../convex/files"

const FEED_KEY = "feed-key-for-tests-0123456789"
const SEO = { title: "", description: "" }

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  return { t, as }
}
const feed = async (t: Awaited<ReturnType<typeof setup>>["t"]) => (await t.fetch("/website/content", { headers: { "X-Feed-Key": FEED_KEY } })).json()

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe("visibility dates", () => {
  it("is live only once the date has come", () => {
    const now = Date.parse("2026-10-27T00:00:00Z")
    expect(isLive(true, null, now)).toBe(true)
    expect(isLive(true, "2026-10-26T00:00:00Z", now)).toBe(true)
    expect(isLive(true, "2026-11-01T00:00:00Z", now)).toBe(false)
    expect(isLive(false, "2026-10-01T00:00:00Z", now)).toBe(false)
  })
  it("keeps, sets or clears the publish date like Shopify", () => {
    const now = Date.parse("2026-10-27T00:00:00Z")
    const past = "2026-01-01T00:00:00.000Z", future = "2026-12-01T00:00:00.000Z"
    expect(nextPublishedAt(true, undefined, past, now)).toBe(past) // old callers: untouched
    expect(nextPublishedAt(true, null, past, now)).toBe(past)
    expect(nextPublishedAt(true, null, future, now)).toBe(new Date(now).toISOString()) // cleared a scheduled date = publish now
    expect(nextPublishedAt(true, future, null, now)).toBe(future)
    expect(nextPublishedAt(false, null, null, now)).toBeNull()
    expect(() => nextPublishedAt(true, "not a date", null, now)).toThrow()
  })
})

describe("pages and blog posts admin", () => {
  it("schedules a page, keeps the template, redirects the old address and does bulk actions", async () => {
    const { t, as } = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    const future = new Date(Date.now() + 7 * 86400000).toISOString()
    const id = await as.mutation(api.content.savePage, { title: "Sale", handle: "", body: "", isPublished: true, seo: SEO, publishedAt: future, templateSuffix: "contact" })
    let data = await feed(t)
    expect(data.pages[0]).toMatchObject({ handle: "sale", isPublished: false, templateSuffix: "contact" })
    // a website update is booked for the publish moment
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
    expect(jobs.some((j) => j.name.includes("queueRebuildInternal") && j.scheduledTime > Date.now() + 6 * 86400000)).toBe(true)

    await as.mutation(api.content.savePage, { id, title: "Sale", handle: "big-sale", body: "", isPublished: true, seo: SEO, publishedAt: null, redirectOld: true })
    data = await feed(t)
    expect(data.pages[0]).toMatchObject({ handle: "big-sale", isPublished: true, templateSuffix: "contact" })
    expect(data.redirects).toEqual([{ path: "/pages/sale", target: "/pages/big-sale" }])

    const id2 = await as.mutation(api.content.savePage, { title: "About", handle: "", body: "", isPublished: true, seo: SEO })
    expect(await as.mutation(api.content.bulkPages, { ids: [id, id2], action: "hide" })).toBe(2)
    expect((await feed(t)).pages.every((p: any) => !p.isPublished)).toBe(true)
    await as.mutation(api.content.bulkPages, { ids: [id2], action: "delete" })
    expect((await as.query(api.content.pages, {}))!.map((p) => p.handle)).toEqual(["big-sale"])
  })

  it("manages blogs: create, rename with redirects, delete only when empty; bulk posts", async () => {
    const { t, as } = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    expect(await as.mutation(api.content.saveBlog, { title: "Guides" })).toBe("guides")
    const pid = await as.mutation(api.content.savePost, {
      blogHandle: "guides", blogTitle: "Guides", title: "Leather care", handle: "", body: "", summary: "", tags: [], author: "", image: null, isPublished: true, publishedAt: null, seo: SEO,
    })
    await expect(as.mutation(api.content.saveBlog, { title: "Guides" })).rejects.toThrow(/already uses/)
    await as.mutation(api.content.saveBlog, { handle: "guides", title: "Shoe guides", newHandle: "shoe-guides", redirectOld: true })
    const data = await feed(t)
    expect(data.posts[0]).toMatchObject({ blogHandle: "shoe-guides", blogTitle: "Shoe guides", handle: "leather-care" })
    expect(data.redirects).toEqual(expect.arrayContaining([{ path: "/blogs/guides", target: "/blogs/shoe-guides" }, { path: "/blogs/guides/*", target: "/blogs/shoe-guides/:splat" }]))
    await expect(as.mutation(api.content.deleteBlog, { handle: "shoe-guides" })).rejects.toThrow(/still has 1 post/)
    await as.mutation(api.content.saveBlog, { title: "News" })
    expect((await as.query(api.content.blogs, {}))!.map((b) => [b.handle, b.posts])).toEqual([["shoe-guides", 1], ["news", 0]])
    await as.mutation(api.content.deleteBlog, { handle: "news" })
    expect(await as.mutation(api.content.bulkPosts, { ids: [pid], action: "hide" })).toBe(1)
    expect((await feed(t)).posts[0].isPublished).toBe(false)
    // links to blog posts are offered in the menu link picker
    expect((await as.query(api.content.linkTargets, {}))!.posts).toEqual([{ title: "Leather care", url: "/blogs/shoe-guides/leather-care" }])
  })
})

describe("URL redirects", () => {
  it("imports CSV rows (skipping bad ones and existing unless asked) and deletes in bulk", async () => {
    const { as } = await setup()
    await as.mutation(api.content.saveRedirect, { path: "/a", target: "/b" })
    const r = await as.mutation(api.content.importRedirects, { overwrite: false, rows: [{ path: "/a", target: "/c" }, { path: "/x", target: "/y" }, { path: "/", target: "/z" }] })
    expect(r).toMatchObject({ added: 1, updated: 0, skipped: 2 })
    expect(r.errors[0]).toMatch(/home page/)
    expect(await as.mutation(api.content.importRedirects, { overwrite: true, rows: [{ path: "/a", target: "/c" }] })).toMatchObject({ updated: 1 })
    const rows = (await as.query(api.content.redirects, {}))!
    expect(rows.map((x) => [x.path, x.target])).toEqual([["/a", "/c"], ["/x", "/y"]])
    expect(await as.mutation(api.content.deleteRedirects, { ids: rows.map((x) => x._id) })).toBe(2)
  })
})

describe("preferences", () => {
  it("saves the social sharing image and still saves older forms without it", async () => {
    const { as } = await setup()
    const base = {
      announcements: [], delivery: { inside: 90, outside: 130 }, preOrderDays: "15–20", contact: { phone: "", whatsapp: "", email: "" },
      social: { facebook: "", instagram: "", tiktok: "", youtube: "" }, policies: [],
      home: { seoTitle: "", seoDescription: "", heroKicker: "", heroTitle: "", heroButton: "", heroLink: "", newCollection: "", bestCollection: "", store1Address: "", store2Address: "", hours: "" },
    }
    await as.mutation(api.content.saveSettings, { settings: base })
    await as.mutation(api.content.saveSettings, { settings: { ...base, home: { ...base.home, shareImage: "https://x.convex.cloud/api/storage/abc" } } })
    expect((await as.query(api.content.settings, {}))!.home.shareImage).toBe("https://x.convex.cloud/api/storage/abc")
    expect((await as.query(api.content.settings, {}))!.delivery).toEqual({ inside: 90, outside: 130 })
    await expect(as.mutation(api.content.saveSettings, { settings: { ...base, home: { ...base.home, shareImage: "not a link" } } })).rejects.toThrow(/sharing image/)
  })
})

describe("files import", () => {
  it("adds the website's pictures and collection pictures by link, once", async () => {
    const { t, as } = await setup()
    await t.run((ctx) => ctx.db.insert("webCollections", { handle: "men", title: "Men", image: "https://cdn.shopify.com/s/files/1/men.jpg?v=1", productHandles: [], updatedAt: 0 }))
    const list = { files: [
      { name: "bb26-hero-desktop.mp4", url: "/assets/files/bb26-hero-desktop.mp4", size: 1000 },
      { name: "bb26-tile-loafers.jpg", url: "/assets/files/bb26-tile-loafers.jpg", size: 2000, w: 800, h: 1000 },
      { name: "notes.txt", url: "/assets/files/notes.txt", size: 1 },
    ] }
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url) === SITE_FILES_URL ? new Response(JSON.stringify(list)) : new Response("no", { status: 404 }))))
    expect(await as.action(api.files.importSiteFiles, {})).toEqual({ found: 3, added: 3 })
    expect(await as.action(api.files.importSiteFiles, {})).toEqual({ found: 3, added: 0 })
    const files = (await as.query(api.files.list, {}))!
    expect(files.map((f) => f.url).sort()).toEqual([
      "https://blackbole-site.pages.dev/assets/files/bb26-hero-desktop.mp4",
      "https://blackbole-site.pages.dev/assets/files/bb26-tile-loafers.jpg",
      "https://cdn.shopify.com/s/files/1/men.jpg?v=1",
    ])
    expect(files.find((f) => f.name === "bb26-tile-loafers.jpg")).toMatchObject({ type: "image/jpeg", w: 800, h: 1000, size: 2000 })
    // deleting a linked file doesn't touch storage
    await as.mutation(api.files.remove, { ids: files.map((f) => f._id as any) })
    expect(await as.query(api.files.list, {})).toEqual([])
    expect(typeFromUrl("https://x/y.MOV?v=2")).toBe("video/quicktime")
  })
})

describe("subscribers admin", () => {
  it("adds by hand and removes", async () => {
    const { as } = await setup()
    expect(await as.mutation(api.subscribers.addManual, { email: "Karim@Mail.com", name: "Karim" })).toBe("added")
    expect(await as.mutation(api.subscribers.addManual, { email: "karim@mail.com", phone: "01700000000" })).toBe("updated")
    const rows = (await as.query(api.subscribers.list, {}))!
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ email: "karim@mail.com", name: "Karim", phone: "01700000000", source: "manual" })
    expect(await as.mutation(api.subscribers.remove, { ids: [rows[0]._id] })).toBe(1)
    expect(await as.query(api.subscribers.list, {})).toEqual([])
  })
})
