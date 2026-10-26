import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"
import { cleanThemeJson, KEEP_ARCHIVED } from "../../convex/themes"

const FEED_KEY = "feed-key-for-tests-0123456789"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  return { t, as }
}

const THEME = {
  settings: { current: { logo: "x" } },
  templates: {
    index: { sections: { home: { type: "bb26-home", settings: { hero_title: "The Veyron Collection" } } }, order: ["home"] },
    product: { sections: { main: { type: "bb26-product", settings: { pre_days: "15–20" } } }, order: ["main"] },
  },
}
const withTitle = (title: string) => JSON.stringify({ ...THEME, templates: { ...THEME.templates, index: { ...THEME.templates.index, sections: { home: { type: "bb26-home", settings: { hero_title: title } } } } } })
const title = (j: any) => j.theme.templates.index.sections.home.settings.hero_title

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe("website themes", () => {
  it("checks theme data", () => {
    expect(JSON.parse(cleanThemeJson({ ...THEME, extra: 1 }))).toEqual(THEME)
    expect(() => cleanThemeJson("{not json")).toThrow(/not valid/)
    expect(() => cleanThemeJson({ settings: {}, templates: { index: {} } })).toThrow(/missing/)
    expect(() => cleanThemeJson({ templates: THEME.templates })).toThrow(/settings/)
  })

  it("imports, edits the draft, publishes, rolls back and serves the feed", async () => {
    const { t, as } = await setup()
    vi.stubEnv("MARKETING_FEED_KEY", FEED_KEY)
    const feed = async (which: string) => (await t.fetch(`/website/theme?which=${which}`, { headers: { "X-Feed-Key": FEED_KEY } })).json()

    // nothing imported yet: the website keeps its own theme
    expect(await feed("live")).toEqual({ theme: null })
    expect((await t.fetch("/website/theme", { headers: { "X-Feed-Key": "nope" } })).status).toBe(401)

    await as.mutation(internal.themes.importTheme, { json: cleanThemeJson(THEME) })
    await expect(as.mutation(internal.themes.importTheme, { json: cleanThemeJson(THEME) })).rejects.toThrow(/already/)
    let o = (await as.query(api.themes.overview, {}))!
    expect(o.live?.name).toBe("BlackBole 2026")
    expect(o.draft?.name).toBe("BlackBole 2026 (draft)")
    const live1 = o.live!._id

    // editing the draft never touches the live feed
    await expect(as.mutation(api.themes.saveDraft, { id: live1, data: withTitle("X") })).rejects.toThrow(/Only the draft/)
    await as.mutation(api.themes.saveDraft, { id: o.draft!._id, data: withTitle("Winter Sale") })
    await expect(as.mutation(api.themes.saveDraft, { id: o.draft!._id, data: "{}" })).rejects.toThrow()
    expect(title(await feed("live"))).toBe("The Veyron Collection")
    expect(title(await feed("draft"))).toBe("Winter Sale")
    expect((await feed("draft")).role).toBe("draft")

    // publish: draft → live, old live archived, a fresh draft copy appears
    await as.mutation(api.themes.publish, { id: o.draft!._id })
    o = (await as.query(api.themes.overview, {}))!
    expect(o.live?.name).toBe("BlackBole 2026")
    expect(o.archived.map((a) => a._id)).toEqual([live1])
    expect(title(await feed("live"))).toBe("Winter Sale")
    expect(title(await feed("draft"))).toBe("Winter Sale")
    expect((await as.query(api.themes.get, { id: o.draft!._id }))!.data.templates.index.sections.home.settings.hero_title).toBe("Winter Sale")
    await expect(as.mutation(api.themes.publish, { id: o.live!._id })).rejects.toThrow(/Only the draft/)
    const rebuild = await t.run((ctx) => ctx.db.query("settings").collect())
    expect(rebuild.some((s: any) => s.key === "websiteRebuild")).toBe(true)

    // one-click roll back puts the previous live theme back
    await as.mutation(api.themes.rollback, {})
    o = (await as.query(api.themes.overview, {}))!
    expect(o.live!._id).toBe(live1)
    expect(title(await feed("live"))).toBe("The Veyron Collection")
    expect(o.archived.length).toBe(1)

    // copy an archived theme to the draft; the old draft is archived, not lost
    const before = o.draft!._id
    const { id: nd } = await as.mutation(api.themes.copyToDraft, { id: o.archived[0]._id })
    o = (await as.query(api.themes.overview, {}))!
    expect(o.draft!._id).toBe(nd)
    expect(o.archived.some((a) => a._id === before && a.name.endsWith("(old draft)"))).toBe(true)
    await as.mutation(api.themes.rename, { id: nd, name: "  Eid look  " })
    expect((await as.query(api.themes.overview, {}))!.draft!.name).toBe("Eid look")
    await expect(as.mutation(api.themes.remove, { id: nd })).rejects.toThrow(/archived/)
  })

  it("keeps only the newest archived themes", async () => {
    const { as } = await setup()
    await as.mutation(internal.themes.importTheme, { json: cleanThemeJson(THEME) })
    for (let i = 0; i < KEEP_ARCHIVED + 3; i++) {
      const o = (await as.query(api.themes.overview, {}))!
      await as.mutation(api.themes.saveDraft, { id: o.draft!._id, data: withTitle(`v${i}`) })
      await as.mutation(api.themes.publish, { id: o.draft!._id })
    }
    const o = (await as.query(api.themes.overview, {}))!
    expect(o.archived.length).toBe(KEEP_ARCHIVED)
  })

  it("needs website permission", async () => {
    const { t, as } = await setup()
    await as.mutation(internal.themes.importTheme, { json: cleanThemeJson(THEME) })
    expect(await t.query(api.themes.overview, {})).toBeNull()
    const o = (await as.query(api.themes.overview, {}))!
    await expect(t.mutation(api.themes.publish, { id: o.draft!._id })).rejects.toThrow(/not signed in/)
  })
})

describe("website files", () => {
  it("adds, lists, searches, renames and deletes files", async () => {
    const { t, as } = await setup()
    const sid = await t.run((ctx) => ctx.storage.store(new Blob(["x"], { type: "image/jpeg" })))
    const { id, url } = await as.mutation(api.files.add, { storageId: sid, name: "winter-banner.jpg", type: "image/jpeg", size: 1234, w: 1600, h: 900 })
    expect(url).toMatch(/^http/)
    const bad = await t.run((ctx) => ctx.storage.store(new Blob(["x"], { type: "application/pdf" })))
    await expect(as.mutation(api.files.add, { storageId: bad, name: "a.pdf", type: "application/pdf", size: 1 })).rejects.toThrow(/Only pictures/)
    expect((await as.query(api.files.list, {}))!.map((f) => f.name)).toEqual(["winter-banner.jpg"])
    expect(await as.query(api.files.list, { q: "summer" })).toEqual([])
    expect(await as.query(api.files.list, { kind: "video" })).toEqual([])
    await as.mutation(api.files.update, { id, alt: "Winter sale banner" })
    expect((await as.query(api.files.list, { q: "sale" }))![0]).toMatchObject({ alt: "Winter sale banner", w: 1600, h: 900 })
    await as.mutation(api.files.remove, { ids: [id] })
    expect(await as.query(api.files.list, {})).toEqual([])
    expect(await t.query(api.files.list, {})).toBeNull()
  })
})
