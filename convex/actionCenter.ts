// Action Center, run by AI every morning (8 am Dhaka) and on "Check now".
// It reads fresh data, finds problems (one card per product / source / area, so a new problem is a new card),
// writes what to do, takes the safe steps itself (reminders, putting stuck orders back on the call list), and
// closes a card by itself once the problem is gone from the data. Decisions about money or customers stay with people.
import { v } from "convex/values"
import { internalAction, internalQuery, action, query } from "./_generated/server"
import { internalMutation } from "./functions"
import { internal } from "./_generated/api"
import { notify, requirePerm } from "./lib"
import { isRealReason } from "./rules"
import { SLA_DAYS } from "./accountability"

const DAY = 86400000
const BD = 6 * 3600000
const DELIVERED = ["delivered_due", "delivered_paid"]
const RETURNED = ["pending_returned", "returned", "damaged"]
const taka = (n: number) => `৳${Math.round(n).toLocaleString("en-IN")}`
const pctTxt = (x: number) => `${Math.round(x * 100)}%`
const startOfDayBD = (t: number) => Math.floor((t + BD) / DAY) * DAY - BD
const AREAS = 11

type Finding = {
  key: string; kind: string; problem: string; finding: string; solution: string; impact: number
  team: string[]; mode: "auto" | "human"; aiDid: string; detail: string[]
  // safe automatic steps the AI takes itself
  followUpOrderIds?: string[]
}

// ---------- data the checks read ----------
export const recentOrders = internalQuery({
  args: { from: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { from, cursor }) => {
    const page = await ctx.db.query("orders").withIndex("by_created", (q) => q.gte("createdAt", from)).paginate({ cursor, numItems: 500 })
    return {
      isDone: page.isDone, cursor: page.continueCursor,
      rows: page.page.filter((o) => !o.deletedAt).map((o) => ({
        status: o.status, source: o.source, city: (o.cityName ?? "").trim(), createdAt: o.createdAt, total: o.total,
        reason: isRealReason(o.reason) ? (o.reasonNote ? `${o.reason} — "${o.reasonNote}"` : o.reason!.trim()) : null,
        items: o.items.map((i) => ({ variantId: i.variantId ?? null, name: i.name, attrs: i.attrs ?? "", qty: i.qty, value: i.price * i.qty - i.discount })),
      })),
    }
  },
})

export const openOrders = internalQuery({
  args: {},
  handler: async (ctx) => {
    const out: any[] = []
    for (const st of ["pending", "on_hold", "approved", "processing", "ready_to_ship", "in_transit", "pre_order", "pre_order_bd"] as const) {
      const rows = await ctx.db.query("orders").withIndex("by_status_changed", (q) => q.eq("status", st).lt("statusChangedAt", Date.now() - DAY)).take(400)
      for (const o of rows) if (!o.deletedAt) out.push({ _id: o._id, invoiceNo: o.invoiceNo, externalName: o.externalName ?? null, status: o.status, statusChangedAt: o.statusChangedAt, followUpAt: o.followUpAt ?? null, total: o.total })
    }
    return out
  },
})

export const unpaidDelivered = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("orders").withIndex("by_delivered", (q) => q.gte("deliveredAt", Date.now() - 90 * DAY).lte("deliveredAt", Date.now() - 10 * DAY)).collect()
    return rows.filter((o) => !o.deletedAt && o.courier === "pathao" && o.consignmentId && !o.courierPaid && DELIVERED.includes(o.status))
      .map((o) => ({ invoiceNo: o.invoiceNo, externalName: o.externalName ?? null, deliveredAt: o.deliveredAt!, amount: Math.max(0, o.total - o.paidAmount) }))
  },
})

export const stockData = internalQuery({
  args: {},
  handler: async (ctx) => {
    const locs = (await ctx.db.query("locations").collect()).filter((l) => l.active && !l.noCourier)
    const real = new Map<string, number>()
    for (const l of locs) {
      for (const s of await ctx.db.query("stock").withIndex("by_location", (q) => q.eq("locationId", l._id)).collect()) {
        real.set(s.variantId, (real.get(s.variantId) ?? 0) + Math.max(0, s.available - (s.virtual ?? 0)))
      }
    }
    const variants = (await ctx.db.query("variants").collect()).filter((x) => x.active)
    const products = new Map((await ctx.db.query("products").collect()).map((p) => [p._id as string, p]))
    return variants.map((x) => {
      const p = products.get(x.productId)
      return { id: x._id as string, sku: x.sku, title: x.title, product: p?.name ?? x.sku, productActive: !!p?.active, cost: x.purchasePrice, real: real.get(x._id) ?? 0 }
    })
  },
})

// ---------- the checks ----------
async function findProblems(ctx: any): Promise<Finding[]> {
  const now = Date.now()
  const today = startOfDayBD(now)
  const orders: any[] = []
  let cursor: string | null = null
  for (let i = 0; i < 40; i++) {
    const r: any = await ctx.runQuery(internal.actionCenter.recentOrders, { from: now - 90 * DAY, cursor })
    orders.push(...r.rows)
    if (r.isDone) break
    cursor = r.cursor
  }
  const [open, unpaid, stock, digest] = await Promise.all([
    ctx.runQuery(internal.actionCenter.openOrders, {}),
    ctx.runQuery(internal.actionCenter.unpaidDelivered, {}),
    ctx.runQuery(internal.actionCenter.stockData, {}),
    ctx.runQuery(internal.accountability.openForDigest, {}).catch(() => null),
  ])
  const out: Finding[] = []
  const live = orders.filter((o) => o.status !== "cancelled")
  const isDel = (o: any) => DELIVERED.includes(o.status)
  const isRet = (o: any) => RETURNED.includes(o.status)
  const inv = (o: any) => o.externalName || `BB-${o.invoiceNo}`

  // 1. Orders nobody has confirmed (pending > 1 day, on hold > 3 days) — AI puts them back on the call list.
  const stuckConfirm = open.filter((o: any) => (o.status === "pending" && now - o.statusChangedAt > DAY) || (o.status === "on_hold" && now - o.statusChangedAt > 3 * DAY))
  if (stuckConfirm.length) {
    const ids = stuckConfirm.filter((o: any) => !o.followUpAt || o.followUpAt > now).map((o: any) => o._id)
    out.push({
      key: "stuck:confirm", kind: "stuck", mode: "auto", team: ["Customer Care"],
      problem: `${stuckConfirm.length} order${stuckConfirm.length > 1 ? "s are" : " is"} waiting too long for a call`,
      finding: `Pending more than 1 day or On hold more than 3 days. Worth ${taka(stuckConfirm.reduce((t: number, o: any) => t + o.total, 0))}. The longer they wait, the more customers cancel or buy elsewhere.`,
      solution: "Call these customers today. Confirm or cancel each one; don't leave them waiting.",
      impact: stuckConfirm.reduce((t: number, o: any) => t + o.total, 0),
      aiDid: "Puts these orders back on today's call list and reminds Customer Care every morning until they are cleared.",
      detail: stuckConfirm.slice(0, 12).map((o: any) => `${inv(o)} · ${o.status === "pending" ? "Pending" : "On hold"} ${Math.floor((now - o.statusChangedAt) / DAY)} days · ${taka(o.total)}`),
      followUpOrderIds: ids,
    })
  }

  // 2. Confirmed but not shipped in 2 days.
  const stuckShip = open.filter((o: any) => ["approved", "processing", "ready_to_ship"].includes(o.status) && now - o.statusChangedAt > 2 * DAY)
  if (stuckShip.length) out.push({
    key: "stuck:ship", kind: "stuck", mode: "auto", team: ["Fulfillment"],
    problem: `${stuckShip.length} confirmed order${stuckShip.length > 1 ? "s have" : " has"} not been shipped for 2+ days`,
    finding: `Worth ${taka(stuckShip.reduce((t: number, o: any) => t + o.total, 0))}. Late shipping is one of the main reasons customers refuse the parcel.`,
    solution: "Pack and hand these to Pathao today. If an item is out of stock, call the customer and offer another size or colour.",
    impact: stuckShip.reduce((t: number, o: any) => t + o.total, 0),
    aiDid: "Reminds Fulfillment every morning with the list until they are shipped.",
    detail: stuckShip.slice(0, 12).map((o: any) => `${inv(o)} · ${o.status.replace(/_/g, " ")} ${Math.floor((now - o.statusChangedAt) / DAY)} days`),
  })

  // 3. With courier for more than 7 days.
  const stuckTransit = open.filter((o: any) => o.status === "in_transit" && now - o.statusChangedAt > 7 * DAY)
  if (stuckTransit.length) out.push({
    key: "stuck:transit", kind: "stuck", mode: "human", team: ["Fulfillment"],
    problem: `${stuckTransit.length} parcel${stuckTransit.length > 1 ? "s have" : " has"} been with Pathao for over 7 days`,
    finding: `Worth ${taka(stuckTransit.reduce((t: number, o: any) => t + o.total, 0))}. Normal delivery is 2–3 days, so these are likely lost, held or about to come back.`,
    solution: "Raise each parcel with Pathao support, and call the customer to check they still want it.",
    impact: stuckTransit.reduce((t: number, o: any) => t + o.total, 0),
    aiDid: "Found the parcels and how long each has been out. Chasing Pathao needs a person.",
    detail: stuckTransit.slice(0, 12).map((o: any) => `${inv(o)} · ${Math.floor((now - o.statusChangedAt) / DAY)} days with courier`),
  })

  // 4. Pre-orders waiting longer than promised.
  const latePre = open.filter((o: any) => (o.status === "pre_order" || o.status === "pre_order_bd") && now - o.statusChangedAt > 25 * DAY)
  if (latePre.length) out.push({
    key: "stuck:preorder", kind: "stuck", mode: "human", team: ["Customer Care"],
    problem: `${latePre.length} pre-order${latePre.length > 1 ? "s are" : " is"} past the promised time`,
    finding: "Waiting more than 25 days. The website promises a refund of the booking money if it arrives late.",
    solution: "Call each customer with a new date, or refund the booking money if they don't want to wait.",
    impact: latePre.reduce((t: number, o: any) => t + o.total, 0),
    aiDid: "Found the late pre-orders. Talking to the customer needs a person.",
    detail: latePre.slice(0, 12).map((o: any) => `${inv(o)} · ${o.status === "pre_order_bd" ? "Bangladesh" : "China"} · ${Math.floor((now - o.statusChangedAt) / DAY)} days`),
  })

  // 5. Orders dropped this week.
  const last7 = live.filter((o) => o.createdAt >= today - 7 * DAY && o.createdAt < today)
  const prev7 = live.filter((o) => o.createdAt >= today - 14 * DAY && o.createdAt < today - 7 * DAY)
  if (prev7.length >= 30 && last7.length < prev7.length * 0.8) {
    const lost = prev7.reduce((t, o) => t + o.total, 0) - last7.reduce((t, o) => t + o.total, 0)
    out.push({
      key: "orders-down", kind: "sales", mode: "human", team: ["Marketing"],
      problem: `Orders fell ${pctTxt(1 - last7.length / prev7.length)} this week`,
      finding: `${last7.length} orders in the last 7 days vs ${prev7.length} the week before (about ${taka(lost)} less).`,
      solution: "Check in this order: ads still running and spending, website checkout working, best sellers in stock, price or offer changes.",
      impact: Math.max(0, lost), aiDid: "Compares every day's orders with the week before.", detail: [],
    })
  }

  // 6. Return rate rising (orders old enough to have finished).
  const rate = (rows: any[]) => { const d = rows.filter(isDel).length, r = rows.filter(isRet).length; return { d, r, n: d + r, rate: d + r ? r / (d + r) : 0 } }
  const recentR = rate(live.filter((o) => o.createdAt >= now - 30 * DAY && o.createdAt < now - 7 * DAY))
  const baseR = rate(live.filter((o) => o.createdAt >= now - 90 * DAY && o.createdAt < now - 30 * DAY))
  if (recentR.n >= 40 && baseR.n >= 40 && recentR.rate > baseR.rate + 0.05) out.push({
    key: "returns-up", kind: "returns", mode: "human", team: ["Customer Care", "Marketing"],
    problem: `Returns went up to ${pctTxt(recentR.rate)}`,
    finding: `Orders from the last 30 days: ${pctTxt(recentR.rate)} returned (${recentR.r} of ${recentR.n}), up from ${pctTxt(baseR.rate)} before.`,
    solution: "Look at the product and area cards below; they show where the extra returns come from. Call new-customer orders before shipping.",
    impact: Math.round((recentR.rate - baseR.rate) * recentR.n * 1900), aiDid: "Compares the return rate every day.", detail: [],
  })

  // 7. Cancellations rising.
  const all7 = orders.filter((o) => o.createdAt >= today - 7 * DAY && o.createdAt < today)
  const all30 = orders.filter((o) => o.createdAt >= today - 37 * DAY && o.createdAt < today - 7 * DAY)
  const cr = (rows: any[]) => rows.length ? rows.filter((o) => o.status === "cancelled").length / rows.length : 0
  if (all7.length >= 20 && all30.length >= 40 && cr(all7) > cr(all30) + 0.08) out.push({
    key: "cancels-up", kind: "sales", mode: "human", team: ["Customer Care"],
    problem: `Cancellations jumped to ${pctTxt(cr(all7))} this week`,
    finding: `${all7.filter((o) => o.status === "cancelled").length} of ${all7.length} orders cancelled in the last 7 days, vs ${pctTxt(cr(all30))} normally.`,
    solution: "Read the cancel reasons on these orders. If customers say 'price' or 'delivery charge', check the offer; if 'no answer', call faster.",
    impact: all7.filter((o) => o.status === "cancelled").reduce((t, o) => t + o.total, 0), aiDid: "Watches the cancel rate every day.", detail: [],
  })

  // 8. Products that come back too often (one card per product).
  const overall = rate(live)
  const byProd = new Map<string, { name: string; del: number; ret: number; retValue: number; reasons: string[] }>()
  for (const o of live) {
    if (!isDel(o) && !isRet(o)) continue
    for (const i of o.items) {
      const k = i.name.trim().toLowerCase()
      const p = byProd.get(k) ?? { name: i.name.trim(), del: 0, ret: 0, retValue: 0, reasons: [] as string[] }
      if (isDel(o)) p.del += i.qty
      else { p.ret += i.qty; p.retValue += i.value; if (o.reason) p.reasons.push(`${i.attrs ? i.attrs + ": " : ""}${o.reason}`) }
      byProd.set(k, p)
    }
  }
  const badProds = [...byProd.entries()].map(([k, p]) => ({ k, ...p, n: p.del + p.ret, rate: p.del + p.ret ? p.ret / (p.del + p.ret) : 0 }))
    .filter((p) => p.n >= 10 && p.rate >= 0.4 && p.rate >= overall.rate + 0.1).sort((a, b) => b.retValue - a.retValue).slice(0, 4)
  for (const p of badProds) out.push({
    key: `product-returns:${p.k}`, kind: "returns", mode: "human", team: ["Marketing", "Customer Care"],
    problem: `${p.name} comes back ${pctTxt(p.rate)} of the time`,
    finding: `Last 90 days: ${p.ret} of ${p.n} pairs returned (shop average ${pctTxt(overall.rate)}). About ${taka(p.retValue)} of sales lost.`,
    solution: p.reasons.length ? "Read the reasons below. If it's size, add a clear size note to the product page; if it's quality or photos, fix them or pause its ads." : "No return reasons were logged, so ask Customer Care to call the last few returns and find out why. Pause its ads until then.",
    impact: Math.round(p.retValue), aiDid: "Counts every product's returns each morning and collects the reasons customers gave.",
    detail: p.reasons.slice(-8).reverse(),
  })

  // 9. Order sources that fail far more than the rest.
  const bySrc = new Map<string, any[]>()
  for (const o of live) bySrc.set(o.source, [...(bySrc.get(o.source) ?? []), o])
  for (const [src, rows] of bySrc) {
    const r = rate(rows)
    if (r.n >= 15 && r.rate > overall.rate + 0.1) out.push({
      key: `source-returns:${src.toLowerCase()}`, kind: "returns", mode: "human", team: ["Customer Care"],
      problem: `${src} orders come back ${pctTxt(r.rate)} of the time`,
      finding: `${r.r} of ${r.n} finished ${src} orders were returned in 90 days, vs ${pctTxt(overall.rate)} overall.`,
      solution: `Call every ${src} order before shipping and ask for the delivery charge in advance from new customers.`,
      impact: Math.round(rows.filter(isRet).reduce((t: number, o: any) => t + o.total, 0)), aiDid: "Compares every order source each morning.", detail: [],
    })
  }

  // 10. Areas that return far more (one card per city / district).
  const byCity = new Map<string, any[]>()
  for (const o of live) if (o.city) byCity.set(o.city, [...(byCity.get(o.city) ?? []), o])
  const badCities = [...byCity.entries()].map(([c, rows]) => ({ c, rows, ...rate(rows) })).filter((x) => x.n >= 20 && x.rate > overall.rate + 0.12).sort((a, b) => b.r - a.r).slice(0, 3)
  for (const x of badCities) out.push({
    key: `area-returns:${x.c.toLowerCase()}`, kind: "returns", mode: "human", team: ["Customer Care"],
    problem: `${x.c}: ${pctTxt(x.rate)} of parcels come back`,
    finding: `${x.r} of ${x.n} finished orders to ${x.c} were returned in 90 days (overall ${pctTxt(overall.rate)}).`,
    solution: `Ask customers in ${x.c} for the Tk 90 delivery charge in advance, or call to confirm before shipping.`,
    impact: Math.round(x.rows.filter(isRet).reduce((t: number, o: any) => t + o.total, 0)), aiDid: "Checks returns by area each morning.", detail: [],
  })

  // 11. Best sellers about to run out, and stock that doesn't move.
  const sold14 = new Map<string, number>(), sold60 = new Map<string, number>()
  for (const o of live) for (const i of o.items) {
    if (!i.variantId) continue
    if (o.createdAt >= now - 14 * DAY) sold14.set(i.variantId, (sold14.get(i.variantId) ?? 0) + i.qty)
    if (o.createdAt >= now - 60 * DAY) sold60.set(i.variantId, (sold60.get(i.variantId) ?? 0) + i.qty)
  }
  const low = new Map<string, { product: string; sizes: string[]; lostPerWeek: number }>()
  for (const s of stock) {
    const sold = sold14.get(s.id) ?? 0
    if (sold < 4 || !s.productActive) continue
    const perDay = sold / 14
    const daysLeft = s.real / perDay
    if (daysLeft >= 7) continue
    const g = low.get(s.product) ?? { product: s.product, sizes: [] as string[], lostPerWeek: 0 }
    g.sizes.push(`${s.title}: ${s.real} left, sells ~${Math.round(perDay * 7)} a week`)
    g.lostPerWeek += perDay * 7 * 1900
    low.set(s.product, g)
  }
  for (const g of [...low.values()].sort((a, b) => b.lostPerWeek - a.lostPerWeek).slice(0, 5)) out.push({
    key: `stock-low:${g.product.toLowerCase()}`, kind: "stock", mode: "auto", team: ["Purchasing"],
    problem: `${g.product} is running out`,
    finding: `${g.sizes.length} best-selling size${g.sizes.length > 1 ? "s have" : " has"} less than a week of stock left.`,
    solution: "Order more of these sizes now, or move the ad budget to a product that is in stock.",
    impact: Math.round(g.lostPerWeek), aiDid: "Checks stock against sales every morning and reminds Purchasing until it is restocked.", detail: g.sizes,
  })
  const dead = stock.filter((s: any) => s.real >= 5 && !(sold60.get(s.id) ?? 0)).map((s: any) => ({ ...s, value: s.real * s.cost })).sort((a: any, b: any) => b.value - a.value)
  const deadValue = dead.reduce((t: number, s: any) => t + s.value, 0)
  if (dead.length && deadValue >= 20000) out.push({
    key: "dead-stock", kind: "stock", mode: "human", team: ["Marketing"],
    problem: `${taka(deadValue)} of stock hasn't sold in 60 days`,
    finding: `${dead.length} sizes have 5+ pairs in the warehouse and no sale in 60 days. That's cash sitting on the shelf.`,
    solution: "Put these in a clearance or combo offer, or show them in ads to people who viewed similar shoes.",
    impact: Math.round(deadValue), aiDid: "Lists the slowest stock (by cost value) every morning.",
    detail: dead.slice(0, 10).map((s: any) => `${s.product} ${s.title}: ${s.real} pairs · ${taka(s.value)} at cost`),
  })

  // 12. Pathao money not paid.
  if (unpaid.length) {
    const amt = unpaid.reduce((t: number, o: any) => t + o.amount, 0)
    if (amt >= 5000) out.push({
      key: "pathao-unpaid", kind: "money", mode: "human", team: ["Accounts"],
      problem: `Pathao hasn't paid ${taka(amt)} for ${unpaid.length} delivered parcels`,
      finding: "Delivered more than 10 days ago and still not in a Pathao payment.",
      solution: "Send this list to Pathao and ask when it will be paid.",
      impact: Math.round(amt), aiDid: "Checks every delivered parcel against Pathao payments each morning.",
      detail: unpaid.sort((a: any, b: any) => a.deliveredAt - b.deliveredAt).slice(0, 12).map((o: any) => `${inv(o)} · delivered ${Math.floor((now - o.deliveredAt) / DAY)} days ago · ${taka(o.amount)}`),
    })
  }

  // 13. Accountability cases nobody answered.
  const overdue = (digest?.rows ?? []).filter((r: any) => now - r.raisedAt >= SLA_DAYS * DAY)
  if (overdue.length) out.push({
    key: "accountability-overdue", kind: "team", mode: "auto", team: [...new Set<string>(overdue.map((r: any) => String(r.team)))],
    problem: `${overdue.length} accountability case${overdue.length > 1 ? "s" : ""} unanswered for ${SLA_DAYS}+ days`,
    finding: "The people responsible were emailed but haven't written back.",
    solution: "Open Accountability and answer each case.",
    impact: 0, aiDid: "Emails the person responsible, and again when it goes overdue.",
    detail: overdue.slice(0, 10).map((r: any) => `${r.team}: ${r.reason}${r.orderInvoice ? ` (${r.orderInvoice})` : ""}`),
  })

  return out
}

// ---------- saving: new cards, updated cards, cards the AI closes itself ----------
export const apply = internalMutation({
  args: { findings: v.array(v.any()), manual: v.boolean() },
  handler: async (ctx, { findings, manual }) => {
    const now = Date.now()
    const seen = new Set<string>()
    let added = 0, fixed = 0
    const reminders: string[] = []
    for (const f of findings as Finding[]) {
      seen.add(f.key)
      const row = await ctx.db.query("actionItems").withIndex("by_key", (q) => q.eq("key", f.key)).unique()
      const log: { at: number; text: string }[] = row?.aiLog ?? []
      // safe step 1: stuck orders go back on today's call list
      if (f.followUpOrderIds?.length) {
        let n = 0
        for (const id of f.followUpOrderIds) {
          const o = await ctx.db.get(id as any) as any
          if (o && (o.status === "pending" || o.status === "on_hold") && (!o.followUpAt || o.followUpAt > now)) { await ctx.db.patch(o._id, { followUpAt: now }); n++ }
        }
        if (n) log.push({ at: now, text: `Put ${n} order${n > 1 ? "s" : ""} back on the call list.` })
      }
      // safe step 2: one reminder a day to the team for the cards the AI handles
      if (f.mode === "auto" && !manual) { reminders.push(`${f.team.join(", ")}: ${f.problem}`); log.push({ at: now, text: `Reminded ${f.team.join(", ")}.` }) }
      // a card a person marked resolved that is still in the data a week later comes back
      const last = await ctx.db.query("findingLogs").withIndex("by_finding", (q) => q.eq("findingId", f.key)).order("desc").first()
      if (last?.status === "resolved" && now - last.at > 7 * DAY) {
        await ctx.db.insert("findingLogs", { findingId: f.key, text: "Still in the data a week after it was marked resolved, so AI reopened it.", status: "open", byName: "AI", at: now })
        log.push({ at: now, text: "Reopened: still in the data a week after it was marked resolved." })
      }
      const { followUpOrderIds: _ignored, ...data } = f
      if (!row) {
        await ctx.db.insert("actionItems", { ...data, status: "open", firstSeen: now, lastSeen: now, aiLog: [{ at: now, text: "Found this in today's check." }, ...log] })
        added++
      } else {
        const reopened = row.status === "fixed"
        if (reopened) { added++; log.push({ at: now, text: "Came back in today's check." }) }
        await ctx.db.patch(row._id, { ...data, status: "open", lastSeen: now, firstSeen: reopened ? now : row.firstSeen, fixedAt: undefined, aiLog: log.slice(-20) })
      }
    }
    // problems that are gone from the data: the AI closes them
    for (const row of await ctx.db.query("actionItems").withIndex("by_status", (q) => q.eq("status", "open")).collect()) {
      if (seen.has(row.key)) continue
      fixed++
      await ctx.db.patch(row._id, { status: "fixed", fixedAt: now, aiLog: [...row.aiLog, { at: now, text: "Gone from today's data, so AI closed it." }].slice(-20) })
    }
    const runRow = await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "actionCenterRun")).unique()
    const run = { at: now, areas: AREAS, open: findings.length, added, fixed }
    if (runRow) await ctx.db.patch(runRow._id, { value: run }); else await ctx.db.insert("settings", { key: "actionCenterRun", value: run })
    if (!manual && (added || fixed || reminders.length)) {
      await notify(ctx, `Action Center: ${added} new, ${fixed} fixed, ${findings.length} open`, reminders.length ? `AI reminders today:\n${reminders.join("\n")}` : "Open Action Center to see today's problems.", undefined, "action")
    }
    return run
  },
})

export const run = internalAction({
  args: { manual: v.optional(v.boolean()) },
  handler: async (ctx, { manual }): Promise<any> => {
    const findings = await findProblems(ctx)
    return await ctx.runMutation(internal.actionCenter.apply, { findings, manual: !!manual })
  },
})

export const lastRun = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "actionCenterRun")).unique())?.value ?? null,
})

/** "Check now" on the page: anyone who can see the dashboard, at most once every 10 minutes. */
export const checkNow = action({
  args: {},
  handler: async (ctx): Promise<any> => {
    const ok = await ctx.runQuery(internal.actionCenter.canView, {})
    if (!ok) throw new Error("Not allowed")
    const last: any = await ctx.runQuery(internal.actionCenter.lastRun, {})
    if (last && Date.now() - last.at < 10 * 60000) return last
    return await ctx.runAction(internal.actionCenter.run, { manual: true })
  },
})
export const canView = internalQuery({
  args: {},
  handler: async (ctx) => { try { await requirePerm(ctx, "dashboard.view"); return true } catch { return false } },
})

/** What the page shows: open problems, plus what the AI closed in the last 7 days. Live, and small. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "dashboard.view")
    const open = await ctx.db.query("actionItems").withIndex("by_status", (q) => q.eq("status", "open")).collect()
    const fixed = await ctx.db.query("actionItems").withIndex("by_status", (q) => q.eq("status", "fixed").gte("lastSeen", Date.now() - 14 * DAY)).collect()
    const run = (await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "actionCenterRun")).unique())?.value ?? null
    return { run, items: [...open, ...fixed.filter((r) => (r.fixedAt ?? 0) > Date.now() - 7 * DAY)] }
  },
})

/** Open problems for the dashboard banner (same shape the old insights used). */
export const openForDashboard = internalQuery({
  args: {},
  handler: async (ctx) => {
    const open = await ctx.db.query("actionItems").withIndex("by_status", (q) => q.eq("status", "open")).collect()
    return open.sort((a, b) => b.impact - a.impact).map((r) => ({
      id: r.key, problem: r.problem, finding: r.finding, solution: r.solution, impact: r.impact,
      status: r.mode === "auto" ? "automatic" : "human", aiDid: r.aiDid, detail: r.detail, team: r.team,
    }))
  },
})
