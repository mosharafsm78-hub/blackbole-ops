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

describe("WhatsApp automatic confirmation", () => {
  it("test mode records what it would send, once per order; weak address is skipped; off sends nothing", async () => {
    const { t, as, order } = await setup()
    const ev = (id: any) => t.run((ctx) => ctx.db.query("waVerifyEvents").withIndex("by_wamid", (q) => q.eq("wamid", `auto-${id}`)).collect())
    const a = await order("01711000011")
    await t.action(internal.whatsappVerify.sendConfirmation, { orderId: a.id })
    expect(await ev(a.id)).toHaveLength(0) // autoSend off by default
    await as.mutation(api.whatsappVerify.saveSettings, { enabled: true, mode: "test", phoneNumberId: "", businessNumber: "8801700000000", autoSend: true })
    await t.action(internal.whatsappVerify.sendConfirmation, { orderId: a.id })
    await t.action(internal.whatsappVerify.sendConfirmation, { orderId: a.id }) // twice → still one
    const e = await ev(a.id)
    expect(e).toHaveLength(1)
    expect(e[0].result).toBe("auto_test")
    expect(e[0].waId).toBe("8801711000011")
    const b = await order("01711000012", "Dhaka")
    await t.action(internal.whatsappVerify.sendConfirmation, { orderId: b.id })
    expect((await ev(b.id))[0].result).toBe("auto_skipped")
  })
  it("live mode posts the template with Confirm/Cancel payloads", async () => {
    const { t, as, order } = await setup()
    await as.mutation(api.whatsappVerify.saveSettings, { enabled: true, mode: "live", phoneNumberId: "999", businessNumber: "8801700000000", autoSend: true, token: "tok", verifyToken: "vt", appSecret: "sec" })
    const calls: any[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }) }))
    const a = await order("01711000013")
    await t.action(internal.whatsappVerify.sendConfirmation, { orderId: a.id })
    vi.unstubAllGlobals()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain("/999/messages")
    expect(calls[0].body.template.name).toBe("order_confirmation")
    expect(calls[0].body.template.components[1].parameters[0].payload).toBe(`wv:c:${a.id}`)
    expect(calls[0].body.template.components[2].parameters[0].payload).toBe(`wv:x:${a.id}`)
    const e = await t.run((ctx) => ctx.db.query("waVerifyEvents").withIndex("by_wamid", (q) => q.eq("wamid", `auto-${a.id}`)).first())
    expect(e?.result).toBe("auto_sent")
  })
})

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
    expect(await status(id)).toBe("approved") // Confirm on WhatsApp approves the order
    const c = await as.mutation(api.whatsappVerify.simulate, { invoice, step: "confirm" }) // tapped twice
    expect(c.result).toBe("already")
    expect(await status(id)).toBe("approved")
  })

  it("pre-order confirmation shows the pre-order days, never 2–3 days", () => {
    const o = { customerName: "Rahim Uddin", invoiceNo: 20001 } as any
    const pre = confirmedText(o, true, "15–20")
    expect(pre).toMatch(/15–20 days/)
    expect(pre).not.toMatch(/2–3 days/)
    expect(confirmedText(o, false)).toMatch(/2–3 days/)
  })

  it("Cancel does not cancel: the order stays Pending, flagged for the team to call", async () => {
    const { as, order, status } = await setup()
    const { id, invoice } = await order("01711000002")
    await as.mutation(api.whatsappVerify.simulate, { invoice, step: "start" })
    const r = await as.mutation(api.whatsappVerify.simulate, { invoice, step: "cancel" })
    expect(r.result).toBe("cancel_requested")
    expect(r.replies[0]).toMatch(/will call you shortly/)
    expect(await status(id)).toBe("pending")
  })

  it("a cancel request nobody acts on is cancelled after 24 hours; confirming first keeps the order", async () => {
    const { as, t, order, status } = await setup()
    const a = await order("01711000012")
    const b = await order("01711000013")
    for (const x of [a, b]) {
      await as.mutation(api.whatsappVerify.simulate, { invoice: x.invoice, step: "start" })
      await as.mutation(api.whatsappVerify.simulate, { invoice: x.invoice, step: "cancel" })
    }
    expect(await t.mutation(internal.whatsappVerify.sweepCancelRequests, {})).toBe(0)
    expect(await status(a.id)).toBe("pending")
    // the customer changes their mind on order b
    await as.mutation(api.whatsappVerify.simulate, { invoice: b.invoice, step: "confirm" })
    await t.run(async (ctx) => {
      for (const x of [a, b]) {
        const o: any = await ctx.db.get(x.id)
        await ctx.db.patch(x.id, { waVerify: { ...o.waVerify, at: Date.now() - 25 * 3600 * 1000 } })
      }
    })
    expect(await t.mutation(internal.whatsappVerify.sweepCancelRequests, {})).toBe(1)
    expect(await status(a.id)).toBe("cancelled")
    expect(await status(b.id)).not.toBe("cancelled")
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

describe("WhatsApp parcel updates", () => {
  it("only for orders placed after it was switched on, once per order, with the Pathao reason, and returned → reorder lead", async () => {
    const { t, as, order, status } = await setup()
    const old = await order("01711000021")
    await as.mutation(api.whatsappVerify.saveSettings, { enabled: true, mode: "test", phoneNumberId: "", businessNumber: "8801700000000", lifecycle: true })
    await new Promise((r) => setTimeout(r, 5))
    const fresh = await order("01711000022")
    await t.run((ctx) => ctx.db.patch(fresh.id, { status: "in_transit", consignmentId: "DB011126TEST01", due: 2020 }))
    const ev = (key: string) => t.run((ctx) => ctx.db.query("waVerifyEvents").withIndex("by_wamid", (q) => q.eq("wamid", key)).collect())
    await t.mutation(internal.waNotify.claim, { orderId: old.id, kind: "shipped" }).then((r) => expect(r).toBeNull()) // placed before switch-on
    const a = await t.mutation(internal.waNotify.claim, { orderId: fresh.id, kind: "failed", reason: "Customer\nnot  answering_phone" })
    expect(a?.params.reason).toBe("Customer not answering phone")
    expect(a?.waId).toBe("8801711000022")
    expect(await t.mutation(internal.waNotify.claim, { orderId: fresh.id, kind: "failed" })).toBeNull() // same attempt twice
    const sh = await t.mutation(internal.waNotify.claim, { orderId: fresh.id, kind: "shipped" })
    expect(sh?.params.tracking).toBe("DB011126TEST01")
    expect(sh?.params.amount).toBe("Tk 2,020")
    expect(await t.mutation(internal.waNotify.claim, { orderId: fresh.id, kind: "shipped" })).toBeNull() // once per order
    // the returned-parcel message is on again (plain Utility template order_returned_v3): claimed once
    expect(await t.mutation(internal.waNotify.claim, { orderId: fresh.id, kind: "returned" })).not.toBeNull()
    expect(await t.mutation(internal.waNotify.claim, { orderId: fresh.id, kind: "returned" })).toBeNull() // once per order
    const yes = await t.mutation(internal.whatsappVerify.inbound, { waId: "8801711000022", wamid: "r1", buttonId: `wv:r:${fresh.id}` })
    expect(yes.result).toBe("reorder_yes")
    expect(await status(fresh.id)).toBe("in_transit") // the reorder button never changes the old order
    const wrong = await t.mutation(internal.whatsappVerify.inbound, { waId: "8801999999999", wamid: "r2", buttonId: `wv:r:${fresh.id}` })
    expect(wrong.result).toBe("not_found")
  })
  it("returned customer: Yes → asked same/different; same → new pending order once; different → team notified", async () => {
    const { t, order } = await setup()
    const o = await order("01711000025")
    const count = () => t.run(async (ctx) => (await ctx.db.query("orders").collect()).length)
    const before = await count()
    const yes = await t.mutation(internal.whatsappVerify.inbound, { waId: "8801711000025", wamid: "s0", buttonId: `wv:r:${o.id}` })
    expect(yes.out[0].kind).toBe("buttons")
    const diff = await t.mutation(internal.whatsappVerify.inbound, { waId: "8801711000025", wamid: "s1", buttonId: `wv:d:${o.id}` })
    expect(diff.result).toBe("reorder_different")
    expect(await count()).toBe(before)
    const same = await t.mutation(internal.whatsappVerify.inbound, { waId: "8801711000025", wamid: "s2", buttonId: `wv:s:${o.id}` })
    expect(same.result).toBe("reorder_same")
    expect(await count()).toBe(before + 1)
    const again = await t.mutation(internal.whatsappVerify.inbound, { waId: "8801711000025", wamid: "s3", buttonId: `wv:s:${o.id}` })
    expect(again.result).toBe("reorder_dup")
    expect(await count()).toBe(before + 1)
  })
  it("never messages shipped for an already-delivered parcel, exchange orders, or prepaid (nothing to pay) orders", async () => {
    const { t, as, order } = await setup()
    await as.mutation(api.whatsappVerify.saveSettings, { enabled: true, mode: "test", phoneNumberId: "", businessNumber: "8801700000000", lifecycle: true })
    await new Promise((r) => setTimeout(r, 5))
    const a = await order("01711000026"), b = await order("01711000027"), c = await order("01711000028")
    await t.run(async (ctx) => {
      await ctx.db.patch(a.id, { status: "delivered_due", consignmentId: "DB1", due: 2000 })
      await ctx.db.patch(b.id, { status: "in_transit", consignmentId: "DB2", due: 2000, isExchange: true })
      await ctx.db.patch(c.id, { status: "in_transit", consignmentId: "DB3", due: 0 })
    })
    for (const x of [a, b, c]) expect(await t.mutation(internal.waNotify.claim, { orderId: x.id, kind: "shipped" })).toBeNull()
    expect(await t.mutation(internal.waNotify.claim, { orderId: a.id, kind: "failed", reason: "x" })).toBeNull()
    expect(await t.mutation(internal.waNotify.claim, { orderId: a.id, kind: "delivered" })).not.toBeNull()
  })
  it("passes the Pathao rider name and a cleaned phone number through", async () => {
    const { t, as, order } = await setup()
    await as.mutation(api.whatsappVerify.saveSettings, { enabled: true, mode: "test", phoneNumberId: "", businessNumber: "8801700000000", lifecycle: true })
    await new Promise((r) => setTimeout(r, 5))
    const o = await order("01711000024")
    await t.run((ctx) => ctx.db.patch(o.id, { status: "in_transit", consignmentId: "DB011126TEST02", due: 2020 }))
    const c = await t.mutation(internal.waNotify.claim, { orderId: o.id, kind: "shipped", rider: "Karim Uddin", riderPhone: "+880 1712-345678" })
    expect(c?.params.rider).toBe("Karim Uddin")
    expect(c?.params.riderPhone).toBe("+8801712345678")
  })
  it("off by default: nothing is claimed", async () => {
    const { t, order } = await setup()
    const o = await order("01711000023")
    expect(await t.mutation(internal.waNotify.claim, { orderId: o.id, kind: "shipped" })).toBeNull()
  })
})
