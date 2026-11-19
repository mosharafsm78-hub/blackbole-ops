import { describe, it, expect } from "vitest"
import { priceOf, costOf, cleanColour, cleanSizes, buildSpec } from "../../convex/chinaImport"

describe("china import", () => {
  it("prices: usd x127 x3 + 750, not doubled", () => {
    expect(priceOf(5.23)).toBe(Math.round(5.23 * 127 * 3 + 750))
    expect(priceOf(5.23)).toBe(2743)
    expect(costOf(5.23)).toBe(1414)
  })
  it("cleans colour names", () => {
    expect(cleanColour("H6001 black")?.name).toBe("Black")
    expect(cleanColour("3300 white blue")?.name).toBe("White/Blue")
    expect(cleanColour("Blacklow")?.name).toBe("Black")
    expect(cleanColour("By007-1 black with fleece lining")?.name).toBe("Black Fleece-Lined")
    expect(cleanColour("Ld007 green velvet")?.name).toBe("Green Velvet-Lined")
    expect(cleanColour("68115 white-gray")?.name).toBe("White/Grey")
    expect(cleanColour("174499788333123176940 yards 1 pair")).toBeNull()
  })
  it("cleans sizes", () => {
    expect(cleanSizes(["39-44"])).toEqual(["39", "40", "41", "42", "43", "44"])
    expect(cleanSizes(["40", "Forty-two", "41", "39"])).toEqual(["39", "40", "41", "42"])
    expect(cleanSizes(["36-37", "38-39", "40-41", "42-43", "44-45"])).toEqual(["40-41", "42-43", "44-45"])
    expect(cleanSizes(["35", "39", "47", "Standard", "40"])).toEqual(["39", "40"])
  })
  it("builds a spec", () => {
    const s = buildSpec({ id: 1601700105007, subject: "x", ladder: [[2, 29, 5.23], [30, 899, 4.69]], attrs: [{ name: "Size", values: [{ name: "39-44", img: null }] }, { name: "Color", values: [{ name: "Black", img: "a.jpg" }, { name: "Grey", img: "b.jpg" }] }], media: ["c.jpg", "a.jpg"], props: [["Upper Material", "Mesh"], ["Outsole Material", "PVC"]] })
    expect(s.price).toBe(2743)
    expect(s.sizes).toEqual(["40", "41", "42", "43", "44"])
    expect(s.title).toBe("Slip-On Work Sneaker")
    expect(s.images).toEqual(["a.jpg", "b.jpg", "c.jpg"])
    expect(s.colours.map((c) => c.code)).toEqual(["BK", "GR"])
    expect(s.descriptionHtml).toContain("Tk 200")
  })
  it("skips products with no price", () => {
    expect(() => buildSpec({ id: 1602010135873, subject: "x", ladder: [], attrs: [], media: [], props: [] })).toThrow(/no price/)
  })
})

describe("china import: other stores", () => {
  it("reads EU sizes written next to US sizes", () => {
    expect(cleanSizes(["6.5(EUR39)", "7(EUR40)", "9.5(EUR45)"])).toEqual(["39", "40", "45"])
  })
  it("names products with no hand-written name", async () => {
    const { autoMeta } = await import("../../convex/chinaImport")
    expect(autoMeta("1602020691638", "Men Plus Size Lace Up Business Dress Shoes Wedding Formal Shoes").type).toBe("Formal Shoes")
    expect(autoMeta("1", "Men Slip On Loafers Driving").t).toMatch(/ Loafer$/)
    expect(autoMeta("2", "Men Chunky Mesh Dad Sneakers").t).toMatch(/ Chunky Sneaker$/)
  })
})
describe("markup", () => {
  it("3.5x for the new stores", () => { expect(priceOf(5, 3.5)).toBe(Math.round(5 * 127 * 3.5 + 750)) })
})
