import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { internal } from "../../convex/_generated/api"

afterEach(() => vi.unstubAllGlobals())

async function setup(o: { status?: string; name?: string; due?: number; sms?: any } = {}) {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const sent: string[] = []
  vi.stubGlobal("fetch", async (url: string) => { sent.push(decodeURIComponent(new URL(url).searchParams.get("messageContent") ?? "")); return new Response(JSON.stringify({ Status: "0", Text: "ACCEPTD" }), { status: 200 }) })
  const orderId = await t.run(async (ctx) => {
    await ctx.db.insert("settings", { key: "sms", value: { enabled: true, provider: "reve", apiKey: "k", secretKey: "s", statuses: ["pending", "in_transit", "out_for_delivery", "failed_delivery", "delivered_paid", "pending_returned"], valuePreference: "due", templates: {}, ...(o.sms ?? {}) } })
    await ctx.db.insert("settings", { key: "contactPoints", value: { hotline: "01805070650" } })
    const customerId = await ctx.db.insert("customers", { code: 1, name: "C", phone: "01711000000", tag: "NEW", orderCount: 0, deliveredCount: 0, returnedCount: 0, cancelledCount: 0, totalSpent: 0, createdAt: 1 } as any)
    const locationId = await ctx.db.insert("locations", { name: "CTG", isDefault: true, active: true } as any)
    return await ctx.db.insert("orders", {
      invoiceNo: 1001, status: o.status ?? "in_transit", source: "Facebook", customerId, customerName: o.name ?? "Rahim Uddin", phone: "01711000000", address: "x", locationId,
      deliveryType: "courier", items: [], subtotal: 0, discount: 0, deliveryFee: 0, paidAmount: 0, total: o.due ?? 2000, due: o.due ?? 2000, callCount: 0, createdByName: "x",
      createdAt: Date.now() - 86400000, updatedAt: 1, statusChangedAt: 1,
    } as any)
  })
  return { t, sent, orderId }
}

describe("parcel SMS (cut returns: keep the money ready, take the parcel)", () => {
  it("out for delivery asks the customer to keep the money ready, and goes out only once", async () => {
    const { t, sent, orderId } = await setup()
    await t.action(internal.outbound.sendOrderSms, { orderId, status: "out_for_delivery" })
    await t.action(internal.outbound.sendOrderSms, { orderId, status: "out_for_delivery" })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/out for delivery/i)
    expect(sent[0]).toMatch(/keep 2000 Tk ready/)
  })
  it("failed delivery and returned have their own messages; one SMS per moment", async () => {
    const { t, sent, orderId } = await setup()
    await t.action(internal.outbound.sendOrderSms, { orderId, status: "failed_delivery" })
    await t.action(internal.outbound.sendOrderSms, { orderId, status: "pending_returned" })
    await t.action(internal.outbound.sendOrderSms, { orderId, status: "pending_returned" })
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatch(/could not deliver/)
    expect(sent[1]).toMatch(/being returned/)
  })
  it("a moment that is not ticked in Settings sends nothing; a Bangla name falls back to plain English (stays one SMS part)", async () => {
    const off = await setup({ sms: { statuses: ["pending"] } })
    await off.t.action(internal.outbound.sendOrderSms, { orderId: off.orderId, status: "failed_delivery" })
    expect(off.sent).toHaveLength(0)
    const bn = await setup({ status: "delivered_paid", name: "রহিম" })
    await bn.t.action(internal.outbound.sendOrderSms, { orderId: bn.orderId, status: "delivered_paid" })
    expect(bn.sent[0]).toMatch(/^Thank you Customer!/)
    expect(/^[\x20-\x7E]+$/.test(bn.sent[0])).toBe(true)
  })
  it("no courier message once the parcel is no longer with the courier", async () => {
    const { t, sent, orderId } = await setup({ status: "delivered_due" })
    await t.action(internal.outbound.sendOrderSms, { orderId, status: "out_for_delivery" })
    expect(sent).toHaveLength(0)
  })
})
