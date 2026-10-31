import { describe, expect, it } from "vitest"
import { buildEvent } from "../../convex/metaCapi"

describe("Conversions API event", () => {
  const order = { invoiceNo: 1234, phone: "01805070650", email: "A@Example.com ", createdAt: Date.parse("2026-11-01T06:00:00Z"), total: 2050, deliveryFee: 70, items: [{ sku: "BB-41", qty: 1, price: 1980 }], city: "Dhaka" }
  it("sends a confirmed order as a Purchase with the order's own time, hashed phone/email, value without delivery", async () => {
    const now = Date.parse("2026-11-02T06:00:00Z")
    const ev = (await buildEvent(order, "Purchase", now))!
    expect(ev).toMatchObject({ event_name: "Purchase", event_time: Math.floor(order.createdAt / 1000), event_id: "bb-1234-purchase", action_source: "website" })
    expect(ev.custom_data).toMatchObject({ currency: "BDT", value: 1980, order_id: "1234", contents: [{ id: "BB-41", quantity: 1, item_price: 1980 }] })
    expect((ev.user_data as any).ph[0]).toMatch(/^[0-9a-f]{64}$/)
    expect((ev.user_data as any).em[0]).toMatch(/^[0-9a-f]{64}$/)
    expect((await buildEvent(order, "Delivered", now))!.event_time).toBe(Math.floor(now / 1000))
  })
  it("refuses an order older than 7 days", async () => {
    expect(await buildEvent(order, "Purchase", Date.parse("2026-11-09T07:00:00Z"))).toBeNull()
  })
})
