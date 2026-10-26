import { describe, expect, it } from "vitest"
import { formatHeroMap, formatTiles, getSettings, homeLayout, parseHeroMap, parseTiles, setHomeLayout, setSetting, THEME_PAGES } from "../src/lib/theme-schema"

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
})
