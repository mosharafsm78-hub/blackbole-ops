import { describe, expect, it } from "vitest"
import {
  formatHeroMap, formatTiles, getGlobals, getSettings, HEROMAP_DEFAULT, historyInit, historyPush, historyRedo, historyUndo, homeLayout, isHexColor,
  parseHeroMap, parseTiles, previewMessage, setGlobal, setHomeLayout, setSetting, THEME_PAGES,
} from "../src/lib/theme-schema"

const T = { settings: {}, templates: { index: { sections: { home: { type: "bb26-home", settings: { hero_title: "A" } } }, order: ["home"] }, product: { sections: {}, order: [] } } }

describe("theme editor data", () => {
  it("sets and clears settings without touching the original", () => {
    const a = setSetting(T, "index", "home", "hero_image_desktop", "https://x/y.jpg")
    expect(getSettings(a, "index", "home")).toEqual({ hero_title: "A", hero_image_desktop: "https://x/y.jpg" })
    expect(getSettings(T, "index", "home")).toEqual({ hero_title: "A" })
    const b = setSetting(a, "index", "home", "hero_title", "  ")
    expect(getSettings(b, "index", "home")).toEqual({ hero_image_desktop: "https://x/y.jpg" })
    const c = setSetting(T, "collection.pre-order", "main", "title", "Book now")
    expect(c.templates["collection.pre-order"]).toEqual({ sections: { main: { type: "bb26-preorder", settings: { title: "Book now" } } }, order: ["main"] })
    expect(setSetting(T, "product", "explore", "men", "a:B").templates.product.sections.explore.type).toBe("bb26-explore")
  })

  it("orders and hides home sections the way the website reads them", () => {
    const ids = THEME_PAGES[0].sections.map((s) => s.id)
    expect(homeLayout(T).map((x) => x.id)).toEqual(ids)
    const moved = [{ id: "stores", hidden: false }, ...ids.filter((i) => i !== "stores").map((id) => ({ id, hidden: id === "craft" }))]
    const d = setHomeLayout(T, moved)
    const s = getSettings(d, "index", "home")
    expect(s.sections_order[0]).toBe("stores")
    expect(s.sections_hidden).toEqual(["craft"])
    expect(homeLayout(d)).toEqual(moved)
    // back to normal: no order/hidden keys at all (the website then renders exactly as before)
    const r = setHomeLayout(d, ids.map((id) => ({ id, hidden: false })))
    expect(getSettings(r, "index", "home")).toEqual({ hero_title: "A" })
  })

  it("reads and writes tile and header-picture lists", () => {
    expect(parseTiles("mens-sandals:Sandals,bags:Bags")).toEqual([{ handle: "mens-sandals", label: "Sandals" }, { handle: "bags", label: "Bags" }])
    expect(formatTiles([{ handle: "bags", label: "Bags, big" }, { handle: "", label: "x" }])).toBe("bags:Bags  big")
    const hm = "sandals:a.jpg,b.jpg\nboot:https://files.convex.cloud/api/storage/1"
    expect(parseHeroMap(hm)).toEqual([{ handle: "sandals", files: ["a.jpg", "b.jpg"] }, { handle: "boot", files: ["https://files.convex.cloud/api/storage/1"] }])
    expect(formatHeroMap(parseHeroMap(hm))).toBe(hm)
  })

  it("keeps theme colours with the other global settings", () => {
    const S = { settings: { current: { logo: "x" } }, templates: T.templates }
    const a = setGlobal(S, "bb_color_bg", "#ffffff")
    expect(a.settings).toEqual({ current: { logo: "x", bb_color_bg: "#ffffff" } })
    expect(getGlobals(a).bb_color_bg).toBe("#ffffff")
    expect(S.settings.current).toEqual({ logo: "x" })
    expect(setGlobal(a, "bb_color_bg", "").settings).toEqual({ current: { logo: "x" } })
    expect(setGlobal(T, "bb_home_bg", "#000").settings).toEqual({ bb_home_bg: "#000" })
    expect(isHexColor("#12345g")).toBe(false)
    expect(isHexColor(" #abc ")).toBe(true)
  })

  it("sends the preview every live field, with built-in values standing in for empty ones", () => {
    const product = THEME_PAGES.find((p) => p.id === "product")!
    const d = setGlobal(setSetting(T, "product", "main", "pre_booking", 300), "bb_color_text", "#112233")
    const m = previewMessage(product, d, "main", false)
    const main = m.sections.find((s) => s.id === "main")!
    expect(main.fields.map((f) => f.id)).not.toContain("other_brands")
    expect(main.fields.map((f) => f.id)).toContain("pair_collection")
    expect(m.sections.find((s) => s.id === "explore")!.fields.find((f) => f.id === "men")!.placeholder).toMatch(/^mens-sandals:Sandals/)
    expect(m.values.pre_booking).toBe(300)
    expect(m.globals.bb_color_text).toBe("#112233")
    expect(m.globals.bb_color_bg).toBe("#FBF9F4")
    expect(m.inspector).toBe(false)
    expect(m.layout).toEqual([])
    const coll = previewMessage(THEME_PAGES.find((p) => p.id === "collection")!, T, null, true)
    expect(coll.sections[0].fields[0].placeholder).toBe(HEROMAP_DEFAULT)
  })

  it("undoes and redoes, typing in one field is one step", () => {
    let h = historyInit("a")
    h = historyPush(h, "ab", "title", 1000)
    h = historyPush(h, "abc", "title", 1500) // same field, quickly: same step
    h = historyPush(h, "x", "link", 1600)
    expect(h.past).toEqual(["a", "abc"])
    h = historyUndo(h)
    expect(h.present).toBe("abc")
    h = historyUndo(h)
    expect(h.present).toBe("a")
    expect(historyUndo(h)).toBe(h)
    h = historyRedo(h)
    expect(h.present).toBe("abc")
    h = historyPush(h, "new", "title", 99999)
    expect(h.future).toEqual([])
    expect(historyRedo(h)).toBe(h)
    expect(historyPush(h, h.present)).toBe(h)
    // a pause starts a new step
    const p = historyPush(historyPush(historyInit("1"), "2", "f", 0), "3", "f", 5000)
    expect(p.past).toEqual(["1", "2"])
  })
})
