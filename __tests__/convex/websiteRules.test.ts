import { describe, expect, it } from "vitest"
import { finishCollections, fromShopifyRuleSet, matchesRules, toRuleProduct } from "../../convex/websiteRules"

const P = (handle: string, tags: string[], type = "Sandals", price = 1980, available = true, publishedAt = "2026-01-01") =>
  ({ handle, title: handle, tags, type, vendor: "BlackBole", publishedAt, variants: [{ price, compareAt: null, available }] })

describe("automatic collections", () => {
  it("reads Shopify rules: ALL tags, NOT tagged, type, price, inventory", () => {
    const r = fromShopifyRuleSet([{ matchType: "ALL", conditions: [
      { __typename: "CollectionSourceInclusionConditionProductTag", relation: "TAGGED_WITH", matchType: "ALL", values: ["bb-footwear", "bb-men"] },
      { __typename: "CollectionSourceInclusionConditionProductTag", relation: "NOT_TAGGED_WITH", matchType: "ALL", values: ["pre-order"] },
      { __typename: "CollectionSourceInclusionConditionVariantPrice", relation: "LESS_THAN", value: { amount: "2000.0" } },
      { __typename: "CollectionSourceInclusionConditionVariantInventory" },
    ] }])!
    expect(r.match).toBe("all")
    expect(matchesRules(toRuleProduct(P("a", ["bb-footwear", "bb-men"])), r)).toBe(true)
    expect(matchesRules(toRuleProduct(P("b", ["bb-footwear"])), r)).toBe(false) // needs both tags
    expect(matchesRules(toRuleProduct(P("c", ["bb-footwear", "bb-men", "pre-order"])), r)).toBe(false)
    expect(matchesRules(toRuleProduct(P("d", ["bb-footwear", "bb-men"], "Sandals", 2500)), r)).toBe(false)
    expect(matchesRules(toRuleProduct(P("e", ["bb-footwear", "bb-men"], "Sandals", 1500, false)), r)).toBe(false)
    expect(fromShopifyRuleSet([{ conditions: [{ __typename: "CollectionSourceInclusionConditionSomethingNew" }] }])).toBeNull()
  })

  it("fills automatic collections (new products first), keeps manual ones, and sorts", () => {
    const products = [P("old", ["bb-men"], "Sandals", 1000, true, "2025-01-01"), P("new", ["bb-men"], "Sandals", 3000, true, "2026-05-01"), P("women", ["bb-women"])]
    const cols = finishCollections(products as any, [
      { handle: "men", productHandles: ["old"], rules: { match: "all", conditions: [{ field: "tag", op: "is", values: ["bb-men"] }] }, sort: "manual" },
      { handle: "picked", productHandles: ["women", "gone"], rules: null, sort: "manual" },
      { handle: "cheap-first", productHandles: ["new", "old"], rules: null, sort: "price-asc" },
    ] as any)
    expect(cols.map((c) => c.productHandles)).toEqual([["new", "old"], ["women"], ["old", "new"]])
  })
})
