import { convexTest } from "convex-test"
import { describe, expect, it, vi } from "vitest"
import schema from "../../convex/schema"
import { api, internal } from "../../convex/_generated/api"
import { confirmedText, detailsProblem, invoiceFromText, phoneKey } from "../../convex/whatsappVerify"

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"))
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "emon@blackbole.com" }))
  const as = t.withIdentity({ subject: `${userId}|s1` })
  await as.mutation(api.team.claim, { name: "Emon" })
  const locationId = (await as.query(api.team.listLocations, {})).find((l) => l.isDefault)!._id
  await as.mutation(api.catalog.saveProduct, { name: "Harbor Shore Sandal - Black", active: true, variants: [{ sku: "BB-HSS-41", title: "41", weightKg: 0.4, price: 1480, purchasePrice: 500, active: true }] })
  const v41 = (await t.run((ctx) => ctx.db.query("variants").withIndex("by_sku", (q) => q.eq("sku", "BB-HSS-41")).unique()))!
  await as.mutation(api.catalog.receiveStock, { locationId, updateCost: true, items: [{ variantId: v41._id, qty: 10, unitCost: 520 }] })
  await as.mutation(api.whatsappVerify.saveSettings, { enabled: true, mode: "test", phoneNumberId: "", businessNumber: "+880 1700-000000" })
  const order = async (phone: string, address = "House 12, Road 5, Lalmatia, Dhaka") => {
    const r = await as.mutation(api.orders.create, { source: "Website", customerName: "Rahim Uddin", phone, address, locationId, deliveryType: "regular", items: [{ variantId: v41._id, qty: 1, price: 1480, discount: 0 }], discount: 0, deliveryFee: 60, advanceAmount: 0, advanceMethod: "bKash", approve: false })
    const o = (await t.run((ctx) => ctx.db.get(r.orderId))) as any
    return { id: r.orderId, invoice: o.invoiceCode ?? `BB-${o.invoiceNo}`, o }
  }
  const status = async (id: any) => ((await t.run((ctx) => ctx.db.get(id))) as any).status
  return { t, as, order, status }
}

describe("WhatsApp order verification", () => {
  it("reads order numbers and phone numbers from messy input", () => {
    expect(invoiceFromText("Verify BB-12345")).toEqual({ no: 12345 })
    expect(invoiceFromText("Hi, I just placed order #29482 (Tk 2,990). I confirm my order.")).toEqual({ ext: "#29482" }) // COD Lion's button
    expect(invoiceFromText("verify bb12345 please")).toEqual({ no: 12345 })
    expect(invoiceFromText("hello")).toBeNull()
    expect(phoneKey("+8801712345678")).toBe(phoneKey("01712345678"))
    expect(detailsProblem({ phone: "01712345678", address: "House 12, Road 5, Lalmatia" })).toBeNull()
    expect(detailsProblem({ phone: "0171234", address: "House 12, Road 5, Lalmatia" })).toMatch(/phone/)
    expect(detailsProblem({ phone: "01712345678", address: "Dhaka" })).toMatch(/address/)
  })

  it("Verify → summary with Confirm/Cancel → Confirm marks confirmed on WhatsApp, notifies ops and sends the arrival message", async () => {
    const { as, order, status } = await setup()
    const { id, invoice } = await order("01711000001")
    const a = await as.mutation(api.whatsappVerify.simulate, { invoice, step: "start" })
    expect(a.result).toBe("asked")
    expect(a.replies[0]).toContain("Rahim")
    expect(a.replies[0]).not.toContain("01711000001") // no order details shown
    expect(a.replies[0]).not.toContain("Lalmatia")
    expect(await status(id)).toBe("pending")
    const b = await as.mutation(api.whatsappVerify.simulate, { invoice, step: "confirm" })
    expect(b.result).toBe("confirmed")
    expect(b.replies[0]).toMatch(/2–3 days/)
    expect(b.replies[0]).toMatch(/courier/)
    expect(b.replies[0]).toMatch(/free exchange/)
    expect(await status(id)).toBe("pending") // not auto-approved: the team sees "Confirmed on WhatsApp" and decides
    const c = await as.mutation(api.whatsappVerify.simulate, { invoice, step: "confirm" }) // tapped twice
    expect(c.result).toBe("already")
    expect(await status(id)).toBe("pending")
  })

  it("pre-order confirmation shows the pre-order days, never 2–3 days", () => {
    const o = { customerName: "Rahim Uddin", invoiceNo: 20001 } as any
    const pre = confirmedText(o, true, "15–20")
    expect(pre).toMatch(/15–20 days/)
    expect(pre).not.toMatch(/2–3 days/)
    expect(confirmedText(o, false)).toMatch(/2–3 days/)
  })

  it("Cancel cancels the order", async () => {
    const { as, order, status } = await setup()
    const { id, invoice } = await order("01711000002")
    await as.mutation(api.whatsappVerify.simulate, { invoice, step: "start" })
    const r = await as.mutation(api.whatsappVerify.simulate, { invoice, step: "cancel" })
    expect(r.result).toBe("cancelled")
    expect(r.replies[0]).toMatch(/customer care team will call/)
    expect(await status(id)).toBe("cancelled")
  })

  it("an incomplete address is never confirmed: the team is asked to call", async () => {
    const { as, order, status } = await setup()
    const { id, invoice } = await order("01711000003", "Dhaka")
    const r = await as.mutation(api.whatsappVerify.simulate, { invoice, step: "start" })
    expect(r.result).toBe("address_issue")
    expect(r.replies[0]).toMatch(/call you/)
    expect(await status(id)).toBe("pending")
  })

  it("a different WhatsApp number can't confirm or cancel someone else's order, and a repeated message acts once", async () => {
    const { t, order, status } = await setup()
    const { id } = await order("01711000004")
    const mine = (waId: string, wamid: string, buttonId: string) => t.mutation(internal.whatsappVerify.inbound, { waId, wamid, buttonId })
    const other = await mine("8801999999999", "w1", `wv:c:${id}`)
    expect(other.result).toBe("mismatch")
    expect(await status(id)).toBe("pending")
    const real = await mine("8801711000004", "w2", `wv:c:${id}`)
    expect(real.result).toBe("confirmed")
    const again = await mine("8801711000004", "w2", `wv:c:${id}`) // WhatsApp delivered it twice
    expect(again.result).toBe("ignored")
    expect(again.out).toEqual([])
  })

  it("the webhook: Meta's address check works, and a signed customer message gets processed", async () => {
    const { t, as, order, status } = await setup()
    await as.mutation(api.whatsappVerify.saveSettings, { enabled: true, mode: "test", phoneNumberId: "1", businessNumber: "8801700000000", token: "tok", verifyToken: "vt", appSecret: "sec" })
    const ok = await t.fetch("/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=777")
    expect(await ok.text()).toBe("777")
    expect((await t.fetch("/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status).toBe(403)
    const { id, invoice } = await order("01711000005")
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "8801711000005", id: "m1", type: "text", text: { body: `Verify ${invoice}` } }] } }] }] })
    expect((await t.fetch("/whatsapp/webhook", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=deadbeef" } })).status).toBe(401)
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("sec"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    const sig = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))).map((b) => b.toString(16).padStart(2, "0")).join("")
    const res = await t.fetch("/whatsapp/webhook", { method: "POST", body, headers: { "x-hub-signature-256": `sha256=${sig}` } })
    expect(res.status).toBe(200)
    const ev = await t.run((ctx) => ctx.db.query("waVerifyEvents").collect())
    expect(ev.map((e) => e.result)).toContain("asked")
    expect(await status(id)).toBe("pending")
  })
})
