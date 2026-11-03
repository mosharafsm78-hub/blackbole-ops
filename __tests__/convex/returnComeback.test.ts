import { describe, expect, it } from "vitest"
import { COMEBACK_FREE, returnComebackEmailContent } from "../../convex/emailTemplates"

describe("return comeback email", () => {
  it("has the code, invoice, name and products", () => {
    const m = returnComebackEmailContent({ name: "Rahim Uddin", invoice: "BB-11825", hotline: "01805070650", picks: [{ name: "Court Classic Sneaker", price: 2380, url: "https://blackbole.top/products/x", imageUrl: "https://cdn.shopify.com/a.jpg" }] })
    expect(m.html).toContain(COMEBACK_FREE)
    expect(m.html).toContain("BB-11825")
    expect(m.html).toContain("Hi Rahim")
    expect(m.html).toContain("Court Classic Sneaker")
    expect(m.text).toContain(COMEBACK_FREE)
  })
})
