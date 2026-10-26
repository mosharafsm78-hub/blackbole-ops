import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"
import { cleanItems, cleanRedirect, CONTENT_EXPORT_URL } from "../../convex/content"

const FEED_KEY = "feed-key-for-tests-0123456789"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  return { t, as }
}

const SETTINGS = {
  announcements: ["Cash on delivery across Bangladesh", "  "],
  delivery: { inside: 80, outside: 120 },
  preOrderDays: "15–20",
  contact: { phone: "01805-070650", whatsapp: "+880 1805-070650", email: "support@blackbole.com" },
  social: { facebook: "https://facebook.com/x", instagram: "", tiktok: "", youtube: "" },
  home: { seoTitle: "BlackBole", seoDescription: "", heroKicker: "", heroTitle: "", heroButton: "", heroLink: "", newCollection: "", bestCollection: "", store1Address: "", store2Address: "", hours: "" },
  policies: [{ type: "SHIPPING_POLICY", title: "Shipping", body: "<p>2–3 days</p>" }],
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe("website content", () => {
  it("cleans menus and redirects", () => {
    expect(cleanItems([{ title: " Men ", url: "/collections/men", items: [{ title: "", url: "/x" }, { title: "Sandals", url: "" }] }, { title: "" }]))
      .toEqual([{ title: "Men", url: "/collections/men", type: "HTTP", items: [{ title: "Sandals", url: "#", type: "HTTP", items: [] }] }])
    expect(cleanRedirect("https://blackbole.top/products/old?x=1", "products/new")).toEqual({ path: "/products/old?x=1", target: "/products/new" })
    expect(() => cleanRedirect("/a", "/a")).toThrow(/same/)
    expect(() => cleanRedirect("/", "/b")).toThrow(/home page/)
  })

  it("saves pages, posts, menus, redirects and settings, and serves them behind the feed key", async () => {
    const { t, as } = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    const pid = await as.mutation(api.content.savePage, { title: "About us", handle: "", body: "<p>Hi</p>", isPublished: true, seo: { title: "", description: "" } })
    await as.mutation(api.content.savePage, { title: "About us", handle: "", body: "", isPublished: false, seo: { title: "", description: "" } })
    await expect(as.mutation(api.content.savePage, { title: "X", handle: "about-us", body: "", isPublished: true, seo: { title: "", description: "" } })).rejects.toThrow(/already uses/)
    await as.mutation(api.content.savePost, {
      blogTitle: "News", blogHandle: "", title: "First post", handle: "", body: "<p>Hello</p>", summary: "", tags: ["a", "a", " b "], author: "Emon",
      image: null, isPublished: true, publishedAt: null, seo: { title: "", description: "" },
    })
    await as.mutation(api.content.saveMenu, { title: "Main", handle: "bb2-main", items: [{ title: "Men", url: "/collections/men", items: [] }] })
    await as.mutation(api.content.saveRedirect, { path: "/products/old", target: "/products/new" })
    await expect(as.mutation(api.content.saveRedirect, { path: "/products/old", target: "/x" })).rejects.toThrow(/already redirects/)
    await as.mutation(api.content.saveSettings, { settings: SETTINGS })
    await expect(as.mutation(api.content.saveSettings, { settings: { ...SETTINGS, delivery: { inside: -1, outside: 120 } } })).rejects.toThrow(/Delivery/)

    expect((await t.fetch("/website/content", { headers: { "X-Feed-Key": "wrong" } })).status).toBe(401)
    const data = await (await t.fetch("/website/content", { headers: { "X-Feed-Key": FEED_KEY } })).json()
    expect(data.pages.map((p: any) => [p.handle, p.isPublished])).toEqual([["about-us", true], ["about-us-2", false]])
    expect(data.posts[0]).toMatchObject({ blogHandle: "news", blogTitle: "News", handle: "first-post", tags: ["a", "b"], isPublished: true })
    expect(data.menus).toEqual([{ handle: "bb2-main", title: "Main", items: [{ title: "Men", url: "/collections/men", type: "HTTP", items: [] }] }])
    expect(data.redirects).toEqual([{ path: "/products/old", target: "/products/new" }])
    expect(data.settings).toMatchObject({ announcements: ["Cash on delivery across Bangladesh"], delivery: { inside: 80, outside: 120 }, contact: { whatsapp: "8801805070650" } })
    // each save asked for a website rebuild
    const rebuild = await t.run((ctx) => ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "websiteRebuild")).unique())
    expect(rebuild?.value?.pending).toBe(true)
    expect(pid).toBeTruthy()
  })

  it("feed pages through many blog posts in small reads, in order", async () => {
    const { t } = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    await t.run(async (ctx) => {
      for (let i = 0; i < 120; i++) {
        await ctx.db.insert("webPosts", { blogHandle: "news", blogTitle: "News", handle: `p${i}`, title: `P${i}`, body: "", tags: [], isPublished: true, pos: 119 - i, updatedAt: 0 })
      }
    })
    const data = await (await t.fetch("/website/content", { headers: { "X-Feed-Key": FEED_KEY } })).json()
    expect(data.posts).toHaveLength(120)
    expect(data.posts[0].handle).toBe("p119")
    expect(data.pages).toEqual([])
    expect(data.settings).toBeNull()
  })

  it("needs website permission", async () => {
    const { t } = await setup()
    const otherId = await t.run((ctx) => ctx.db.insert("users", { email: "x@blackbole.com" }))
    const other = t.withIdentity({ subject: `${otherId}|s2` })
    await expect(other.mutation(api.content.savePage, { title: "A", handle: "", body: "", isPublished: true, seo: { title: "", description: "" } })).rejects.toThrow()
    expect(await other.query(api.content.pages, {})).toBeNull()
  })

  it("imports from the current website without duplicates, and never overwrites saved settings", async () => {
    const { t, as } = await setup()
    const EXPORT = {
      pages: [{ handle: "contact", title: "Contact", body: "<p>c</p>", isPublished: true, templateSuffix: "contact", seo: { title: "", description: "" } }],
      posts: [{ blogHandle: "news", blogTitle: "News", pos: 0, handle: "p1", title: "P1", body: "", tags: [], isPublished: true }],
      menus: [{ handle: "footer", title: "Quick Links", items: [{ title: "About", url: "/pages/about-us", type: "PAGE", items: [] }] }],
      redirects: [{ path: "/a", target: "/b" }],
      settings: SETTINGS,
    }
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url) === CONTENT_EXPORT_URL ? new Response(JSON.stringify(EXPORT)) : new Response("no", { status: 404 }))))
    expect(await as.action(api.content.importContent, { what: "all" })).toEqual({ pages: 1, posts: 1, menus: 1, redirects: 1, settings: 1 })
    expect(await as.action(api.content.importContent, { what: "all" })).toEqual({ pages: 1, posts: 1, menus: 1, redirects: 1, settings: 0 })
    const counts = await as.query(api.content.overview, {})
    expect(counts).toMatchObject({ pages: 1, posts: 1, menus: 1, redirects: 1, settings: true })
    const page = await t.run((ctx) => ctx.db.query("webPages").first())
    expect(page?.templateSuffix).toBe("contact")
    void internal
  })
})
