import { v, ConvexError } from "convex/values"
import { action, internalQuery, internalAction } from "./_generated/server"
import { internalMutation } from "./functions"
import { internal } from "./_generated/api"
import { getSetting, requirePerm } from "./lib"
import { ownersConf } from "./accountability"
import { awardPoints } from "./kpi"

const DAY = 86400000

export const cfg = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "ads.view")
    return (await getSetting<any>(ctx, "metaAds")) ?? null
  },
})

/** Meta settings for the Marketing OS feed (no signed-in person). Only used server-side to read spend. */
export const cfgForFeed = internalQuery({
  args: {},
  handler: async (ctx) => (await getSetting<any>(ctx, "metaAds")) ?? null,
})

export const revenueByDay = internalQuery({
  args: { from: v.number(), to: v.number(), locationId: v.optional(v.string()) },
  handler: async (ctx, { from, to, locationId }) => {
    const orders = await ctx.db.query("orders").withIndex("by_created", (q) => q.gte("createdAt", from).lte("createdAt", to)).collect()
    const out: Record<string, { orders: number; value: number; delivered: number; deliveredValue: number }> = {}
    for (const o of orders) {
      if (o.deletedAt || o.status === "cancelled" || (locationId && o.locationId !== locationId)) continue
      const d = new Date(o.createdAt + 6 * 3600000).toISOString().slice(0, 10)
      const r = (out[d] ??= { orders: 0, value: 0, delivered: 0, deliveredValue: 0 })
      r.orders++; r.value += o.total
      if (o.status.startsWith("delivered")) { r.delivered++; r.deliveredValue += o.total }
    }
    return out
  },
})

export const analytics = action({
  args: { from: v.number(), to: v.number(), accountId: v.optional(v.string()), locationId: v.optional(v.string()) },
  handler: async (ctx, a): Promise<any> => {
    const conf = await ctx.runQuery(internal.ads.cfg, {})
    if (!conf?.token || !conf.accounts?.length) return { configured: false }
    const accounts = (conf.accounts as { id: string; name: string }[]).filter((x) => !a.accountId || x.id === a.accountId)
    const since = new Date(a.from + 6 * 3600000).toISOString().slice(0, 10)
    const until = new Date(a.to + 6 * 3600000).toISOString().slice(0, 10)
    const spend: Record<string, { spend: number; impressions: number; clicks: number; purchases: number }> = {}
    const campaigns: any[] = []
    for (const acc of accounts) {
      const url = `https://graph.facebook.com/v21.0/act_${acc.id}/insights?level=account&time_increment=1&fields=spend,impressions,clicks,actions&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&access_token=${encodeURIComponent(conf.token)}`
      const res = await fetch(url)
      const json: any = await res.json()
      if (json.error) throw new ConvexError(`Meta: ${json.error.message}`)
      for (const r of json.data ?? []) {
        const d = r.date_start
        const s = (spend[d] ??= { spend: 0, impressions: 0, clicks: 0, purchases: 0 })
        s.spend += Number(r.spend ?? 0); s.impressions += Number(r.impressions ?? 0); s.clicks += Number(r.clicks ?? 0)
        s.purchases += Number((r.actions ?? []).find((x: any) => x.action_type === "purchase" || x.action_type === "offsite_conversion.fb_pixel_purchase")?.value ?? 0)
      }
      const cu = `https://graph.facebook.com/v21.0/act_${acc.id}/insights?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,actions&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&limit=100&access_token=${encodeURIComponent(conf.token)}`
      const cj: any = await (await fetch(cu)).json()
      for (const r of cj.data ?? []) campaigns.push({ account: acc.name, id: r.campaign_id, name: r.campaign_name, spend: Number(r.spend ?? 0), clicks: Number(r.clicks ?? 0), impressions: Number(r.impressions ?? 0) })
    }
    const revenue = await ctx.runQuery(internal.ads.revenueByDay, { from: a.from, to: a.to, locationId: a.locationId })
    const days = [...new Set([...Object.keys(spend), ...Object.keys(revenue)])].sort()
    const daily = days.map((d) => ({ day: d, spend: spend[d]?.spend ?? 0, orders: revenue[d]?.orders ?? 0, value: revenue[d]?.value ?? 0, deliveredValue: revenue[d]?.deliveredValue ?? 0 }))
    const totalSpend = daily.reduce((s, d) => s + d.spend, 0)
    const totalValue = daily.reduce((s, d) => s + d.value, 0)
    const totalOrders = daily.reduce((s, d) => s + d.orders, 0)
    return {
      configured: true, accounts: conf.accounts, daily,
      totals: { spend: totalSpend, orders: totalOrders, value: totalValue, roas: totalSpend ? totalValue / totalSpend : 0, cpo: totalOrders ? totalSpend / totalOrders : 0 },
      campaigns: campaigns.sort((x, y) => y.spend - x.spend),
    }
  },
})

/** Runs weekly (see crons.ts), looking back at the 7 days just finished. Reuses the exact same spend+revenue
 *  computation `analytics` uses for the dashboard, so the number that pays out is the same number Emon can see
 *  on screen — never a separately-maintained copy that could drift from it. Awards Marketing's lead the moment
 *  the account as a whole hit or beat the configured weekly ROAS target; actions can't write the ledger
 *  themselves, so the actual award goes through awardRoasHit below. */
export const weeklyRoasCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const conf = await ctx.runQuery(internal.ads.cfg, {})
    if (!conf?.token || !conf.accounts?.length) return // Meta Ads not configured — nothing to check yet

    const to = Date.now()
    const from = to - 7 * DAY
    const since = new Date(from + 6 * 3600000).toISOString().slice(0, 10)
    const until = new Date(to + 6 * 3600000).toISOString().slice(0, 10)
    let totalSpend = 0
    for (const acc of conf.accounts as { id: string; name: string }[]) {
      const url = `https://graph.facebook.com/v21.0/act_${acc.id}/insights?level=account&time_increment=1&fields=spend&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&access_token=${encodeURIComponent(conf.token)}`
      const res = await fetch(url)
      const json: any = await res.json()
      if (json.error) return // a transient Meta API error shouldn't block or mis-score this week — just skip; next week's cron tries again
      for (const r of json.data ?? []) totalSpend += Number(r.spend ?? 0)
    }
    if (totalSpend <= 0) return // nothing spent — "hit the target" is meaningless with no spend behind it

    const revenue: Record<string, { orders: number; value: number; delivered: number; deliveredValue: number }> = await ctx.runQuery(internal.ads.revenueByDay, { from, to })
    const totalValue = Object.values(revenue).reduce((s, d) => s + d.value, 0)
    const roas = totalValue / totalSpend
    const target = (await ctx.runQuery(internal.ads.roasTargetQuery, {})) ?? 2.0
    if (roas >= target) {
      await ctx.runMutation(internal.ads.awardRoasHit, { roas: Math.round(roas * 100) / 100, target })
      return
    }
    // An outright loss (spend that didn't even come back as revenue), not merely missing the target — missing
    // the target by itself isn't penalized, since a target can be ambitious without a miss being a real fault.
    if (roas < 1.0) {
      await ctx.runMutation(internal.ads.awardRoasLoss, { roas: Math.round(roas * 100) / 100 })
    }
  },
})

export const roasTargetQuery = internalQuery({
  args: {},
  handler: async (ctx) => (await getSetting<number>(ctx, "roasTarget")) ?? 2.0,
})

export const awardRoasHit = internalMutation({
  args: { roas: v.number(), target: v.number() },
  handler: async (ctx, { roas, target }) => {
    const owners = await ownersConf(ctx)
    const lead = owners.byTeam["Marketing"]
    if (!lead?.name) return
    // Idempotency by time window, not orderId (there's no order behind this one) — same pattern as
    // accountability.weeklyCleanCheck: skip if already awarded in the last 6 days, so a cron that fires twice
    // in the same week can't double-pay it.
    const already = await ctx.db.query("kpiEvents").withIndex("by_staff", (q) => q.eq("staffName", lead.name).gte("at", Date.now() - 6 * DAY)).collect()
    if (already.some((e) => e.ruleKey === "marketing.roas_hit")) return
    await awardPoints(ctx, { staffName: lead.name, ruleKey: "marketing.roas_hit", label: `Hit the weekly ROAS target (${roas.toFixed(2)}x vs ${target}x target)` })
  },
})

export const awardRoasLoss = internalMutation({
  args: { roas: v.number() },
  handler: async (ctx, { roas }) => {
    const owners = await ownersConf(ctx)
    const lead = owners.byTeam["Marketing"]
    if (!lead?.name) return
    // Same weekly idempotency pattern as awardRoasHit — a cron that fires twice in the same week can't
    // double-dock it either.
    const already = await ctx.db.query("kpiEvents").withIndex("by_staff", (q) => q.eq("staffName", lead.name).gte("at", Date.now() - 6 * DAY)).collect()
    if (already.some((e) => e.ruleKey === "marketing.roas_loss")) return
    await awardPoints(ctx, { staffName: lead.name, ruleKey: "marketing.roas_loss", label: `Ad spend ran at an outright loss for the week (${roas.toFixed(2)}x ROAS)` })
  },
})
