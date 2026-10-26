import { describe, expect, it } from "vitest"
import { WEBSITE_NAV, websiteNavKey, websiteNavParent } from "@/components/website-nav"

describe("Website sidebar menu", () => {
  it("maps each Website page to its menu entry", () => {
    expect(websiteNavKey("/website", { tab: "products" })).toBe("products")
    expect(websiteNavKey("/website", { tab: "collections" })).toBe("collections")
    expect(websiteNavKey("/website-product")).toBe("products")
    expect(websiteNavKey("/website-new")).toBe("products")
    expect(websiteNavKey("/website-collection")).toBe("collections")
    expect(websiteNavKey("/website-inventory")).toBe("inventory")
    expect(websiteNavKey("/website-reviews")).toBe("reviews")
    expect(websiteNavKey("/website-discount")).toBe("discounts")
    expect(websiteNavKey("/website-navigation")).toBe("menus")
    expect(websiteNavKey("/website-post")).toBe("blog")
    expect(websiteNavKey("/website-page")).toBe("pages")
    expect(websiteNavKey("/website-theme-editor")).toBe("themes")
    expect(websiteNavKey("/website-settings")).toBe("preferences")
    expect(websiteNavKey("/website-subscribers")).toBe("subscribers")
    expect(websiteNavKey("/website-home")).toBe("home")
    expect(websiteNavKey("/website-analytics")).toBe("analytics")
    expect(websiteNavKey("/orders")).toBeNull()
    expect(websiteNavKey("/websites")).toBeNull()
  })

  it("opens the right main item", () => {
    expect(websiteNavParent("collections")).toBe("products")
    expect(websiteNavParent("reviews")).toBe("products")
    expect(websiteNavParent("menus")).toBe("content")
    expect(websiteNavParent("preferences")).toBe("store")
    expect(websiteNavParent("subscribers")).toBe("customers")
    expect(websiteNavParent("discounts")).toBe("discounts")
  })

  it("has the Shopify order", () => {
    expect(WEBSITE_NAV.map((n) => n.label)).toEqual(["Home", "Analytics", "Products", "Discounts", "Content", "Online Store", "Customers"])
  })
})
