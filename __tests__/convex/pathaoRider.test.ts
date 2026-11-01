import { describe, it, expect } from "vitest"
import { riderOf, reasonOf } from "../../convex/pathao"

const log = { data: { tracking: [
  { message: "Assigned to Zia Hossen (01778866835) for delivery." },
  { message: "Delivery on hold. Reason: Customer is not available at the delivery address" },
  { message: "Assigned to Karim Uddin (01712345678) for delivery." },
] } }

describe("Pathao tracking text", () => {
  it("reads the latest rider from the tracking sentence", () => {
    expect(riderOf(log)).toEqual({ rider: "Karim Uddin", riderPhone: "01712345678" })
  })
  it("reads the hold/failed reason", () => {
    expect(reasonOf(log)).toBe("Customer is not available at the delivery address")
  })
  it("returns nothing when there is no rider", () => {
    expect(riderOf({ a: "At the sorting hub" })).toEqual({})
  })
})
