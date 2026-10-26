import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"
import { cleanSubmission, htmlToText, parseJudgeMeHtml } from "../../convex/reviews"

const FEED_KEY = "feed-key-for-tests-0123456789"

// Same structure as Judge.me's reviews_for_widget answer (single-quoted attributes, one unquoted)
const rev = (o: { id: string; score: number; name: string; title: string; body: string; when: string; verified?: boolean; pics?: string; reply?: string }) => `
<div class='jdgm-rev jdgm-divider-top' data-verified-buyer='${o.verified ? "true" : "false"}' data-review-id='${o.id}' data-review-language='' data-product-title='BlackBole Saltway Edge Sandal For Men' data-product-url='/products/blackbole-saltway-edge-sandal-for-men-1' data-thumb-up-count='0' data-thumb-down-count='0'>
  <div class='jdgm-rev__header'>
    <div class='jdgm-rev__icon'>${o.name[0]}</div>
    <span class='jdgm-rev__rating' data-score='${o.score}' tabindex='0' aria-label='${o.score} star review' role='img'><span class='jdgm-star jdgm--on'></span></span>
    <time class='jdgm-rev__timestamp jdgm-spinner' datetime='${o.when}' data-content='${o.when.replace("T", " ").replace("Z", " UTC")}'></time>
    <div class='jdgm-rev__br'></div>
    <span class='jdgm-rev__buyer-badge-wrapper'></span>
    <span class='jdgm-rev__author-wrapper'><span class='jdgm-rev__author'>${o.name}</span><span class='jdgm-rev__location'></span></span>
  </div>
  <div class='jdgm-rev__content'>
    <div class='jdgm-rev__custom-form'></div>
    <b class='jdgm-rev__title'>${o.title}</b>
    <div class='jdgm-rev__body'><p>${o.body}</p></div>
    <div class='jdgm-rev__pics'>${o.pics ?? ""}</div>
    <div class='jdgm-rev__vids'></div>
    <div class='jdgm-rev__transparency-badge-wrapper'><div class='jdgm-rev__transparency-badge' data-badge-type=review_collected_from_another_provider></div></div>
  </div>
  <div class='jdgm-rev__actions'><div class='jdgm-rev__social'></div><div class='jdgm-rev__votes'></div></div>
  ${o.reply ? `<div class='jdgm-rev__reply'><div class='jdgm-rev__replier-wrapper'><b class='jdgm-rev__replier'></b></div><div class='jdgm-rev__reply-content'><p>${o.reply}</p></div></div>` : ""}
</div>`

const PAGE = `<div class='jdgm-rev-widg__reviews'>${rev({ id: "11111111-2222-3333-4444-555555555555", score: 5, name: "Rakib Hasan", title: "Really Comfortable", body: "Very comfortable &amp; premium.<br>Second line", when: "2024-09-19T00:00:00Z", verified: true, reply: "Thank you so much! ❤️",
  pics: `<a class='jdgm-rev__photo-link jdgm-rev__pic-link' href='https://judgeme.imgix.net/blackbole/abc.jpg?auto=format' data-mfp-src='https://judgeme.imgix.net/blackbole/abc.jpg?auto=format'><img class='jdgm-rev__pic-img' data-src='https://judgeme.imgix.net/blackbole/abc.jpg?auto=format&w=160' alt='User picture'/></a>` })}
${rev({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", score: 4, name: "Siam Kabir", title: "Good Everyday Sandal", body: "Finishing could be better", when: "2024-11-19T03:36:07Z" })}
</div><div class='jdgm-paginate' data-per-page='5' data-url='https://api.judge.me/reviews/reviews_for_widget'><button class='jdgm-paginate__page jdgm-curt' data-page='1'>1</button></div>`

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  return { t, as }
}

afterEach(() => { vi.unstubAllEnvs() })

describe("Judge.me widget parser", () => {
  it("reads every field of a review", () => {
    const r = parseJudgeMeHtml(PAGE)
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({
      extId: "11111111-2222-3333-4444-555555555555", handle: "blackbole-saltway-edge-sandal-for-men-1", rating: 5, author: "Rakib Hasan",
      title: "Really Comfortable", body: "Very comfortable & premium.\nSecond line", verified: true, reply: "Thank you so much! ❤️",
      photos: ["https://judgeme.imgix.net/blackbole/abc.jpg?auto=format"], createdAt: Date.parse("2024-09-19T00:00:00Z"),
      productTitle: "BlackBole Saltway Edge Sandal For Men",
    })
    expect(r[1]).toMatchObject({ rating: 4, verified: false, photos: [], reply: "", createdAt: Date.parse("2024-11-19T03:36:07Z") })
    expect(parseJudgeMeHtml("<div class='jdgm-rev-widg__reviews'></div>")).toEqual([])
  })
  it("turns HTML into plain text", () => {
    expect(htmlToText("<p>A &lt;b&gt; &#39;x&#39;</p><p>B</p>")).toBe("A <b> 'x'\nB")
  })
})

describe("website reviews", () => {
  it("imports idempotently, keeps hidden reviews hidden, and feeds only published ones", async () => {
    const { t, as } = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    const rows = parseJudgeMeHtml(PAGE)
    expect(await t.mutation(internal.reviews.upsertImported, { rows, fallbackHandle: "x" })).toEqual({ added: 2, updated: 0 })
    expect(await t.mutation(internal.reviews.upsertImported, { rows, fallbackHandle: "x" })).toEqual({ added: 0, updated: 2 })
    const list = await as.query(api.reviews.list, {})
    expect(list!.reviews).toHaveLength(2)
    const siam = list!.reviews.find((r) => r.author === "Siam Kabir")!
    await as.mutation(api.reviews.setStatus, { ids: [siam._id], status: "hidden" })
    await t.mutation(internal.reviews.upsertImported, { rows, fallbackHandle: "x" })
    const get = (key = FEED_KEY) => t.fetch("/website/reviews", { method: "GET", headers: { "X-Feed-Key": key } })
    expect((await get("wrong")).status).toBe(401)
    const feed = await (await get()).json()
    expect(feed.reviews).toHaveLength(1)
    expect(feed.reviews[0]).toMatchObject({ id: "11111111-2222-3333-4444-555555555555", handle: "blackbole-saltway-edge-sandal-for-men-1", rating: 5, date: "2024-09-19T00:00:00.000Z" })
    // not signed in → nothing
    expect(await t.query(api.reviews.list, {})).toBeNull()
  })

  it("imports from Judge.me's public widget for every product, copying photos into our storage", async () => {
    const { as } = await setup()
    const calls: string[] = []
    vi.stubGlobal("fetch", async (u: string) => {
      calls.push(String(u))
      if (String(u).includes("imgix")) return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }))
      const url = new URL(String(u))
      const mine = url.searchParams.get("product_id") === "8760395530377" && url.searchParams.get("page") === "1"
      return new Response(JSON.stringify({ html: mine ? PAGE : "<div class='jdgm-rev-widg__reviews'></div>", total_count: mine ? 2 : 0, page: url.searchParams.get("page") }), { headers: { "Content-Type": "application/json" } })
    })
    try {
      const r = await as.action(api.reviews.importJudgeMe, { productIds: ["8760395530377", "8760407031945"] })
      expect(r).toMatchObject({ products: 2, withReviews: 1, found: 2, added: 2, updated: 0, photos: 1, failed: [] })
      expect(calls.some((c) => c.startsWith("https://judge.me/reviews/reviews_for_widget?url=a88d34-65.myshopify.com&shop_domain=a88d34-65.myshopify.com"))).toBe(true)
      const list = await as.query(api.reviews.list, {})
      const rakib = list!.reviews.find((x) => x.author === "Rakib Hasan")!
      expect(rakib.photos).toHaveLength(1)
      expect(rakib.photos[0]).not.toContain("imgix")
      // again: nothing new, photos not downloaded twice
      const n = calls.filter((c) => c.includes("imgix")).length
      expect(await as.action(api.reviews.importJudgeMe, { productIds: ["8760395530377"] })).toMatchObject({ added: 0, updated: 2, photos: 0 })
      expect(calls.filter((c) => c.includes("imgix")).length).toBe(n)
      expect(list!.lastImport).toMatchObject({ found: 2 })
    } finally { vi.unstubAllGlobals() }
  })

  it("takes reviews written on the website as pending, with checks and a per-IP limit", async () => {
    const { t, as } = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    const post = (body: unknown) => t.fetch("/website/reviews", { method: "POST", headers: { "X-Feed-Key": FEED_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const ok = { handle: "harbor-shore", rating: 5, name: "Rina", body: "Lovely pair", ip: "1.2.3.4" }
    expect((await post({ ...ok, rating: 0 })).status).toBe(400)
    expect((await post({ ...ok, body: "buy at https://spam.example" })).status).toBe(400)
    for (let i = 0; i < 5; i++) expect((await post(ok)).status).toBe(200)
    expect((await post(ok)).status).toBe(429)
    const list = await as.query(api.reviews.list, {})
    expect(list!.reviews).toHaveLength(5)
    expect(list!.reviews[0]).toMatchObject({ status: "pending", source: "website", author: "Rina" })
    const feed = await (await t.fetch("/website/reviews", { method: "GET", headers: { "X-Feed-Key": FEED_KEY } })).json()
    expect(feed.reviews).toHaveLength(0)
    await as.mutation(api.reviews.setStatus, { ids: [list!.reviews[0]._id], status: "published" })
    await as.mutation(api.reviews.setReply, { id: list!.reviews[0]._id, reply: "Thanks!" })
    const feed2 = await (await t.fetch("/website/reviews", { method: "GET", headers: { "X-Feed-Key": FEED_KEY } })).json()
    expect(feed2.reviews).toEqual([expect.objectContaining({ author: "Rina", reply: "Thanks!" })])
    expect(cleanSubmission({ handle: "Bad Handle!", rating: 5, name: "a", body: "abc" })).toEqual({ error: "Unknown product" })
  })
})
