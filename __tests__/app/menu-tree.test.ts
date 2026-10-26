import { describe, expect, it } from "vitest"
import { parseCsv } from "../../src/lib/csv"
import { addChild, build, flatten, moveBlock, normalize, redirectsFromCsv, redirectsToCsv, removeBlock, shiftBlock, type MenuItem } from "../../src/lib/menu-tree"

const M = (title: string, items: MenuItem[] = []): MenuItem => ({ title, url: `/${title.toLowerCase()}`, type: "HTTP", items })
const names = (items: MenuItem[]): any[] => items.map((i) => (i.items.length ? [i.title, names(i.items)] : i.title))

describe("menu tree", () => {
  const tree = [M("Men", [M("Shoes", [M("Loafers")]), M("Sandals")]), M("Women"), M("Sale")]

  it("flattens and builds back the same tree", () => {
    expect(build(flatten(tree))).toEqual(tree)
  })

  it("moves an item with its sub-items and changes its level", () => {
    const rows = flatten(tree) // Men, Shoes, Loafers, Sandals, Women, Sale
    // drag "Shoes" (and Loafers) to the end, top level
    expect(names(build(moveBlock(rows, 1, rows.length, 0)))).toEqual([["Men", ["Sandals"]], "Women", "Sale", ["Shoes", ["Loafers"]]])
    // drag "Sale" under "Women"
    expect(names(build(moveBlock(rows, 5, 5, 1)))).toEqual([["Men", [["Shoes", ["Loafers"]], "Sandals"]], ["Women", ["Sale"]]])
    // never deeper than 3 levels: Shoes has a child, so it can go at most one level under Women
    expect(names(build(moveBlock(rows, 1, 5, 2)))).toEqual([["Men", ["Sandals"]], ["Women", [["Shoes", ["Loafers"]]]], "Sale"])
    // dropping an item inside itself does nothing
    expect(moveBlock(rows, 1, 2, 0)).toBe(rows)
  })

  it("indents, outdents, adds and removes", () => {
    const rows = flatten(tree)
    expect(names(build(shiftBlock(rows, 4, 1)))).toEqual([["Men", [["Shoes", ["Loafers"]], "Sandals", "Women"]], "Sale"])
    expect(names(build(shiftBlock(rows, 3, -1)))).toEqual([["Men", [["Shoes", ["Loafers"]]]], "Sandals", "Women", "Sale"])
    expect(names(build(addChild(rows, 4, { title: "Heels", url: "/heels", type: "HTTP" })))).toEqual([["Men", [["Shoes", ["Loafers"]], "Sandals"]], ["Women", ["Heels"]], "Sale"])
    expect(names(build(removeBlock(rows, 0)))).toEqual(["Women", "Sale"])
    expect(normalize([{ key: "a", title: "A", url: "", type: "", depth: 2 }])[0].depth).toBe(0)
  })
})

describe("redirects CSV", () => {
  it("reads Shopify's export and writes the same format", () => {
    const csv = redirectsToCsv([{ path: "/a", target: "/b,c" }])
    expect(csv).toBe('Redirect from,Redirect to\n/a,"/b,c"\n')
    expect(redirectsFromCsv(parseCsv(csv))).toEqual([{ path: "/a", target: "/b,c" }])
    expect(redirectsFromCsv(parseCsv("Redirect to,Redirect from\n/new,/old\n"))).toEqual([{ path: "/old", target: "/new" }])
    expect(redirectsFromCsv(parseCsv("/x,/y\n"))).toEqual([{ path: "/x", target: "/y" }])
  })
})
