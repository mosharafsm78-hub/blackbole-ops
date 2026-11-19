import { describe, expect, it } from "vitest"
import { isChinaPreorder, preorderAmounts } from "../../convex/preorderCheckout"
import { deliveryDueOnDelivery, preOrderFullPrice } from "../../convex/shopify"

describe("China pre-order checkout", () => {
  it("only China pre-orders qualify", () => {
    expect(isChinaPreorder(["pre-order", "supplier-wenling"], null)).toBe(true)
    expect(isChinaPreorder(["pre-order", "made-in-china"], null)).toBe(true)
    expect(isChinaPreorder(["pre-order", "pre-order-delivery-advance"], null)).toBe(false) // Bangladesh pre-order
    expect(isChinaPreorder(["pre-order", "supplier-x", "made-in-bangladesh"], null)).toBe(false)
    expect(isChinaPreorder(["pre-order", "supplier-x"], "90")).toBe(false) // delivery-charge booking
    expect(isChinaPreorder(["supplier-x"], null)).toBe(false)
  })
  it("booking: ৳200 now, rest + ৳90 delivery on delivery", () => {
    expect(preorderAmounts(200, 3186, "book")).toEqual({ full: 3186, unit: 200, shipping: 0, dueOnDelivery: 3186 - 200 + 90 })
  })
  it("pay in full: 15% off + ৳90 delivery now, nothing on delivery", () => {
    expect(preorderAmounts(200, 3186, "full")).toEqual({ full: 3186, unit: 2708, shipping: 90, dueOnDelivery: 0 })
  })
  it("Ops reads the orders right", () => {
    const booking = { price: "200", quantity: 1, properties: [{ name: "Full price", value: "Tk 3,186" }, { name: "Delivery charge on delivery", value: "Tk 90" }] }
    const full = { price: "2708", quantity: 1, properties: [{ name: "Full price", value: "Tk 3,186" }, { name: "Paid in full", value: "15% off · Tk 2,708" }] }
    expect(preOrderFullPrice(booking)).toBe(3186) // rider collects the rest of the price
    expect(deliveryDueOnDelivery([booking])).toBe(90) // ...plus the delivery charge
    expect(preOrderFullPrice(full)).toBeNull() // line price is what was paid
    expect(deliveryDueOnDelivery([full])).toBe(0)
  })
})
