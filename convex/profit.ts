// Profit page: order by order, what each order earned or lost, with its real costs.
//
//  • Meta spend: copied from the Meta API per campaign per day (metaSpend table). A website order gets the spend of
//    the campaign in its link, on the day it was ordered, split equally between that campaign's orders that day.
//    Orders the team typed in from Messenger / WhatsApp / Facebook / phone get ৳0. Spend no order can be linked to
//    is shown as its own line, so the month's Meta total here always equals Meta Ads Manager.
//  • Courier: Pathao's own fee for the parcel from its invoice (delivery + COD + return). Before the invoice, the fee
//    Pathao quoted when the parcel was booked (marked "not invoiced yet").
//  • Product cost: purchase price of each size in Ops. Packaging and monthly fixed costs: Settings → costs.
import { v, ConvexError } from "convex/values"
import { action, internalAction, internalQuery, query } from "./_generated/server"
import { internalMutation } from "./functions"
import { internal } from "./_generated/api"
import { getSetting, currentStaff } from "./lib"
import { hasPerm } from "./rules"
import { cached } from "./dashboard"
import { DEFAULT_COSTS, fixedTotal, type MonthlyCosts } from "./targetPlan"

const DAY = 86400000
const BD = 6 * 3600000
const bdDay = (t: number) => new Date(t + BD).toISOString().slice(0, 10)
const DELIVERED = ["delivered_due", "delivered_paid"]
const RETURNED = ["pending_returned", "returned", "damaged"]
/** Orders typed in by the team from a chat or call: no Meta spend on them (Emon's rule). */
export const metaFreeSource = (source: string) => source !== "Website"

// ---------------- Meta spend sync ----------------
export const saveSpend = internalMutation({
  args: { days: v.array(v.string()), rows: v.array(v.object({ day: v.string(), accountId: v.string(), campaignId: v.string(), campaignName: v.string(), spend: v.number() })), info: v.any() },
  handler: async (ctx, { days, rows, info }) => {
    const now = Date.now()
    for (const d of days) for (const r of await ctx.db.query("metaSpend").withIndex("by_day", (q) => q.eq("day", d)).collect()) await ctx.db.delete(r._id)
    for (const r of rows) await ctx.db.insert("metaSpend", { ...r, syncedAt: now })
    const row = await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "metaSpendSync")).unique()
    const value = { at: now, from: days[0], to: days[days.length - 1], rows: rows.length, ...info }
    if (row) await ctx.db.patch(row._id, { value }); else await ctx.db.insert("settings", { key: "metaSpendSync", value })
  },
})

export const syncSpend = internalAction({
  args: { from: v.optional(v.string()), to: v.optional(v.string()) },
  handler: async (ctx, a): Promise<any> => {
    const conf: any = await ctx.runQuery(internal.ads.cfgForFeed, {})
    if (!conf?.token || !conf.accounts?.length) return { configured: false }
    const to = a.to ?? bdDay(Date.now())
    const from = a.from ?? bdDay(Date.now() - 3 * DAY)
    const days: string[] = []
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) days.push(new Date(t).toISOString().slice(0, 10))
    const rows: { day: string; accountId: string; campaignId: string; campaignName: string; spend: number }[] = []
    const accounts: any[] = []
    for (const acc of conf.accounts as { id: string; name: string }[]) {
      const ai: any = await (await fetch(`https://graph.facebook.com/v21.0/act_${acc.id}?fields=timezone_name,currency&access_token=${encodeURIComponent(conf.token)}`)).json()
      if (ai.error) throw new ConvexError(`Meta: ${ai.error.message}`)
      let url: string | null = `https://graph.facebook.com/v21.0/act_${acc.id}/insights?level=campaign&time_increment=1&fields=campaign_id,campaign_name,spend&limit=500&time_range=${encodeURIComponent(JSON.stringify({ since: from, until: to }))}&access_token=${encodeURIComponent(conf.token)}`
      let total = 0
      while (url) {
        const j: any = await (await fetch(url)).json()
        if (j.error) throw new ConvexError(`Meta: ${j.error.message}`)
        for (const r of j.data ?? []) {
          const spend = Number(r.spend ?? 0)
          if (!spend) continue
          rows.push({ day: r.date_start, accountId: acc.id, campaignId: String(r.campaign_id), campaignName: String(r.campaign_name ?? ""), spend })
          total += spend
        }
        url = j.paging?.next ?? null
      }
      accounts.push({ id: acc.id, name: acc.name, timezone: ai.timezone_name, currency: ai.currency, total: Math.round(total * 100) / 100 })
    }
    await ctx.runMutation(internal.profit.saveSpend, { days, rows, info: { accounts } })
    return { days: days.length, rows: rows.length, accounts }
  },
})

/** Fills the whole of the current and last month (run daily, and once by hand). */
export const syncMonths = internalAction({
  args: { months: v.optional(v.number()) },
  handler: async (ctx, { months = 2 }): Promise<any> => {
    const now = new Date(Date.now() + BD)
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1)).toISOString().slice(0, 10)
    return await ctx.runAction(internal.profit.syncSpend, { from: start, to: bdDay(Date.now()) })
  },
})

// ---------------- data the report reads ----------------
export const ordersPage = internalQuery({
  args: { from: v.number(), to: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { from, to, cursor }) => {
    const page = await ctx.db.query("orders").withIndex("by_created", (q) => q.gte("createdAt", from).lte("createdAt", to)).paginate({ cursor, numItems: 400 })
    return {
      isDone: page.isDone, cursor: page.continueCursor,
      rows: page.page.filter((o) => !o.deletedAt).map((o) => ({
        id: o._id as string, invoice: o.externalName || o.invoiceCode || `BB-${o.invoiceNo}`, createdAt: o.createdAt, status: o.status, source: o.source,
        campaignId: o.campaignId ?? null, customer: o.customerName, total: o.total, isExchange: !!o.isExchange,
        consignmentId: o.consignmentId ?? null, courierCost: o.courierCost ?? null, courierFee: o.courierFee ?? null,
        courierCollected: o.courierCollected ?? null, courierPaid: !!o.courierPaid,
        items: o.items.map((i) => ({ variantId: (i.variantId as string | undefined) ?? null, sku: i.sku, name: i.name.trim(), attrs: i.attrs ?? "", qty: i.qty, value: i.price * i.qty - i.discount })),
      })),
    }
  },
})

export const refData = internalQuery({
  args: { fromDay: v.string(), toDay: v.string() },
  handler: async (ctx, { fromDay, toDay }) => {
    const spend: { day: string; campaignId: string; campaignName: string; spend: number }[] = []
    for (let t = Date.parse(`${fromDay}T00:00:00Z`); t <= Date.parse(`${toDay}T00:00:00Z`); t += DAY) {
      const d = new Date(t).toISOString().slice(0, 10)
      for (const r of await ctx.db.query("metaSpend").withIndex("by_day", (q) => q.eq("day", d)).collect()) spend.push({ day: r.day, campaignId: r.campaignId, campaignName: r.campaignName, spend: r.spend })
    }
    // a list, not an object: Convex objects are capped at 1024 fields and there are thousands of sizes
    const costList = (await ctx.db.query("variants").collect()).map((x) => [x._id as string, x.sku, x.purchasePrice] as [string, string, number])
    const costs = { salary: 0, rent: 0, other: 0, ...DEFAULT_COSTS, ...((await getSetting<MonthlyCosts>(ctx, "monthlyCosts")) ?? {}) }
    const sync = await getSetting<any>(ctx, "metaSpendSync")
    return { spend, costList, costs, sync }
  },
})

export const viewer = internalQuery({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    return { view: hasPerm(s.perms, "reports.view"), manager: hasPerm(s.perms, "team.manage") }
  },
})

// ---------------- the calculation ----------------
type Outcome = "delivered" | "returned" | "cancelled" | "open"
const outcomeOf = (s: string): Outcome => DELIVERED.includes(s) ? "delivered" : RETURNED.includes(s) ? "returned" : s === "cancelled" ? "cancelled" : "open"

export async function buildProfit(ctx: any, from: number, to: number) {
  const fromDay = bdDay(from), toDay = bdDay(to)
  const orders: any[] = []
  let cursor: string | null = null
  for (let i = 0; i < 50; i++) {
    const r: any = await ctx.runQuery(internal.profit.ordersPage, { from, to, cursor })
    orders.push(...r.rows)
    if (r.isDone) break
    cursor = r.cursor
  }
  const ref: any = await ctx.runQuery(internal.profit.refData, { fromDay, toDay })
  ref.cost = {} as Record<string, number>; ref.costBySku = {} as Record<string, number>
  for (const [id, sku, price] of ref.costList as [string, string, number][]) { ref.cost[id] = price; ref.costBySku[sku] = price }
  const packaging = Number(ref.costs.packaging ?? 0)

  // 1. Meta spend per campaign-day, and which orders it belongs to
  const spendKey = new Map<string, { spend: number; name: string; campaignId: string; day: string }>()
  const nameToId = new Map<string, string>() // "day|lower name" -> campaign id, for links that carry the campaign name
  let metaTotal = 0
  for (const s of ref.spend) {
    const k = `${s.day}|${s.campaignId}`
    const e = spendKey.get(k) ?? { spend: 0, name: s.campaignName, campaignId: s.campaignId, day: s.day }
    e.spend += s.spend
    spendKey.set(k, e)
    nameToId.set(`${s.day}|${s.campaignName.trim().toLowerCase()}`, s.campaignId)
    metaTotal += s.spend
  }
  const linkOf = (o: any): string | null => {
    if (metaFreeSource(o.source) || !o.campaignId) return null
    const day = bdDay(o.createdAt)
    if (spendKey.has(`${day}|${o.campaignId}`) || /^\d{6,}$/.test(o.campaignId)) return `${day}|${o.campaignId}`
    const id = nameToId.get(`${day}|${String(o.campaignId).trim().toLowerCase()}`)
    return id ? `${day}|${id}` : null
  }
  const ordersPerKey = new Map<string, number>()
  for (const o of orders) { const k = linkOf(o); if (k && spendKey.has(k)) ordersPerKey.set(k, (ordersPerKey.get(k) ?? 0) + 1) }

  // 2. Each order
  const rows: any[] = []
  let metaOnOrders = 0
  for (const o of orders) {
    const outcome = outcomeOf(o.status)
    const k = linkOf(o)
    const camp = k ? spendKey.get(k) : undefined
    const meta = camp ? camp.spend / (ordersPerKey.get(k!) ?? 1) : 0
    metaOnOrders += meta
    let productCost = 0, costMissing = false
    for (const i of o.items) {
      const c = (i.variantId && ref.cost[i.variantId]) ?? ref.costBySku[i.sku]
      if (!c) costMissing = true
      productCost += (c ?? 0) * i.qty
    }
    const shipped = !!o.consignmentId || outcome === "delivered" || outcome === "returned"
    let courier = 0, courierNote: "invoice" | "booked" | "none" = "none"
    if (o.courierCost != null) { courier = o.courierCost; courierNote = "invoice" }
    else if (o.consignmentId && o.courierFee != null && outcome !== "cancelled") { courier = o.courierFee; courierNote = "booked" }
    const pack = shipped && outcome !== "cancelled" ? packaging : 0
    let revenue = 0, cogs = 0
    if (outcome === "delivered") { revenue = o.total; cogs = productCost }
    else if (outcome === "returned") { revenue = o.courierCollected ?? 0; cogs = o.status === "damaged" ? productCost : 0 }
    const profit = outcome === "open" ? null : revenue - cogs - courier - pack - meta
    rows.push({
      id: o.id, invoice: o.invoice, createdAt: o.createdAt, status: o.status, outcome, source: o.source, customer: o.customer,
      campaign: camp ? camp.name : null, campaignTag: o.campaignId, value: o.total,
      items: o.items.map((i: any) => `${i.name}${i.attrs ? ` - ${i.attrs}` : ""}${i.qty > 1 ? ` ×${i.qty}` : ""}`),
      revenue: Math.round(revenue), productCost: Math.round(productCost), cogs: Math.round(cogs), courier: Math.round(courier), courierNote,
      packaging: pack, meta: Math.round(meta * 100) / 100, profit: profit === null ? null : Math.round(profit * 100) / 100, costMissing,
      _items: o.items,
    })
  }

  // 3. Totals by outcome
  const outcomes: Record<Outcome, any> = {} as any
  for (const oc of ["delivered", "returned", "cancelled", "open"] as Outcome[]) {
    const rs = rows.filter((r) => r.outcome === oc)
    outcomes[oc] = {
      orders: rs.length, value: rs.reduce((t, r) => t + r.value, 0), revenue: rs.reduce((t, r) => t + r.revenue, 0),
      productCost: rs.reduce((t, r) => t + r.cogs, 0), courier: rs.reduce((t, r) => t + r.courier, 0), packaging: rs.reduce((t, r) => t + r.packaging, 0),
      meta: rs.reduce((t, r) => t + r.meta, 0), profit: oc === "open" ? null : rs.reduce((t, r) => t + (r.profit ?? 0), 0),
      metaOrders: rs.filter((r) => r.meta > 0).length,
    }
  }

  // 4. Spend no order could be linked to, by campaign
  const unlinked = new Map<string, { name: string; spend: number }>()
  for (const [k, e] of spendKey) {
    if (ordersPerKey.get(k)) continue
    const u = unlinked.get(e.campaignId) ?? { name: e.name, spend: 0 }
    u.spend += e.spend
    unlinked.set(e.campaignId, u)
  }
  const metaUnlinked = metaTotal - metaOnOrders

  // 5. By product (an order's costs shared between its items by value)
  const prod = new Map<string, any>()
  for (const r of rows) {
    if (r.outcome === "open") continue
    const totalVal = r._items.reduce((t: number, i: any) => t + i.value, 0) || 1
    for (const i of r._items) {
      const share = i.value / totalVal
      const c = (i.variantId && ref.cost[i.variantId]) ?? ref.costBySku[i.sku] ?? 0
      const p = prod.get(i.name) ?? { name: i.name, delivered: 0, returned: 0, cancelled: 0, revenue: 0, productCost: 0, courier: 0, packaging: 0, meta: 0, profit: 0 }
      p[r.outcome] += i.qty
      const rev = r.outcome === "delivered" ? i.value + (r.revenue - r._items.reduce((t: number, x: any) => t + x.value, 0)) * share : r.revenue * share
      const cogs = r.outcome === "delivered" || r.status === "damaged" ? c * i.qty : 0
      p.revenue += rev; p.productCost += cogs; p.courier += r.courier * share; p.packaging += r.packaging * share; p.meta += r.meta * share
      p.profit += rev - cogs - r.courier * share - r.packaging * share - r.meta * share
      prod.set(i.name, p)
    }
  }

  // 6. Fixed costs for the days chosen (each month's fixed cost spread over its days)
  const fixedMonth = fixedTotal(ref.costs)
  let fixed = 0
  for (let t = Date.parse(`${fromDay}T00:00:00Z`); t <= Date.parse(`${toDay}T00:00:00Z`); t += DAY) {
    const d = new Date(t)
    fixed += fixedMonth / new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  }
  const finishedProfit = outcomes.delivered.profit + outcomes.returned.profit + outcomes.cancelled.profit

  const r2 = (n: number) => Math.round(n * 100) / 100
  return {
    from, to, fromDay, toDay, builtAt: Date.now(), sync: ref.sync,
    meta: {
      total: r2(metaTotal), onOrders: r2(metaOnOrders), unlinked: r2(metaUnlinked),
      linkedOrders: rows.filter((r) => r.meta > 0).length,
      websiteOrders: rows.filter((r) => !metaFreeSource(r.source)).length,
      websiteNoCampaign: rows.filter((r) => !metaFreeSource(r.source) && !r.campaignTag).length,
      chatOrders: rows.filter((r) => metaFreeSource(r.source)).length,
      unlinkedCampaigns: [...unlinked.entries()].map(([id, u]) => ({ id, name: u.name, spend: r2(u.spend) })).sort((a, b) => b.spend - a.spend).slice(0, 15),
    },
    outcomes, packaging,
    fixed: { month: fixedMonth, period: Math.round(fixed) },
    totals: {
      orders: rows.length, finishedProfit: r2(finishedProfit),
      netProfit: r2(finishedProfit - metaUnlinked - fixed),
      deliveredRevenue: outcomes.delivered.revenue,
    },
    products: [...prod.values()].map((p) => ({ ...p, revenue: Math.round(p.revenue), productCost: Math.round(p.productCost), courier: Math.round(p.courier), packaging: Math.round(p.packaging), meta: Math.round(p.meta), profit: Math.round(p.profit) })).sort((a, b) => b.delivered + b.returned - (a.delivered + a.returned)),
    orders: rows.sort((a, b) => b.createdAt - a.createdAt).map(({ _items, ...r }) => r),
  }
}

export const report = action({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }): Promise<any> => {
    const who: any = await ctx.runQuery(internal.profit.viewer, {})
    if (!who?.view) throw new ConvexError("You don't have permission to see profit.")
    let data: any = await cached(ctx, `profit:${from}:${to}`, 3 * 60000, () => buildProfit(ctx, from, to))
    if (!data) { // cleared by "Refresh from Meta"
      data = await buildProfit(ctx, from, to)
      await ctx.runMutation(internal.dashboard.writeCache, { key: `profit:${from}:${to}`, value: data })
    }
    if (who.manager) return { ...data, manager: true }
    // Team members see every order's profit; salary, rent and other fixed costs stay with managers.
    return { ...data, manager: false, fixed: null, totals: { ...data.totals, netProfit: null } }
  },
})

/** "Refresh from Meta" button: re-reads the chosen days' spend now (at most once a minute). */
export const refreshSpend = action({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }): Promise<any> => {
    const who: any = await ctx.runQuery(internal.profit.viewer, {})
    if (!who?.view) throw new ConvexError("You don't have permission.")
    const last: any = await ctx.runQuery(internal.profit.lastSync, {})
    if (last && Date.now() - last.at < 60000) return last
    const r = await ctx.runAction(internal.profit.syncSpend, { from: bdDay(from), to: bdDay(Math.min(to, Date.now())) })
    await ctx.runMutation(internal.dashboard.writeCache, { key: `profit:${from}:${to}`, value: null })
    return r
  },
})
export const lastSync = internalQuery({ args: {}, handler: async (ctx) => (await getSetting<any>(ctx, "metaSpendSync")) ?? null })

export const syncStatus = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    return (await getSetting<any>(ctx, "metaSpendSync")) ?? null
  },
})
