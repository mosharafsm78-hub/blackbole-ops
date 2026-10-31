import { v, ConvexError } from "convex/values"
import { paginationOptsValidator } from "convex/server"
import { internalAction, internalQuery, query } from "./_generated/server"
import { internalMutation, mutation } from "./functions"
import { internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import { currentStaff, invoiceLabel, nextCounter, requirePerm } from "./lib"
import { STATUS_LABEL, RETURN_AT_FAULT_REASONS, type OrderStatus } from "./rules"

export const REPORT_TYPES = [
  { key: "sales_creation", label: "Sales Report by Creation", index: "by_created", field: "createdAt" },
  { key: "sales_approved", label: "Sales Report by Approved", index: "by_approved", field: "approvedAt" },
  { key: "sales_delivered", label: "Sales Report by Delivered", index: "by_delivered", field: "deliveredAt" },
  { key: "product_creation", label: "Sales By Base Product by Creation", index: "by_created", field: "createdAt" },
  { key: "product_delivered", label: "Sales By Base Product by Delivered", index: "by_delivered", field: "deliveredAt" },
  { key: "daily_product_source_status", label: "Daily Product-wise Sales Report based on Order Source and Order Status", index: "by_created", field: "createdAt" },
  { key: "paid_due", label: "Orders Paid and Due Amount Report", index: "by_created", field: "createdAt" },
  { key: "payments", label: "Payment Transaction Report", index: "", field: "at" },
  { key: "stock_summary", label: "By Product Stock Summary", index: "", field: "" },
  { key: "attribution", label: "Origin/Attribution Based Order Performance Report", index: "by_created", field: "createdAt" },
  // The feedback and return calls teams log every day (logCsat/logReturnCsat/logRecovery in orders.ts) were
  // previously write-only: captured per order, worth individual KPI points, maybe an accountability flag — but
  // never rolled up anywhere, so there was no way to see "is CSAT trending down", "which return reason keeps
  // coming back", or "is the recovery call actually winning customers back". These three reports turn that data
  // into dynamic, aggregated business signal instead of leaving it buried in individual order timelines.
  { key: "csat_trend", label: "Feedback & Return Call Trend (Daily)", index: "by_created", field: "createdAt" },
  { key: "return_reasons", label: "Return Call Reason Breakdown & Win-Back Rate", index: "by_created", field: "createdAt" },
  { key: "csat_by_agent", label: "Feedback & Return Call Performance by Agent", index: "by_created", field: "createdAt" },
] as const

const BD = 6 * 3600000
const day = (t?: number) => (t ? new Date(t + BD).toISOString().slice(0, 10) : "")
const baseName = (n: string) => n.replace(/\s+-\s+[^-]+$/, "")

export const page = internalQuery({
  args: { index: v.string(), from: v.number(), to: v.number(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { index, from, to, paginationOpts }) => {
    const field = index === "by_created" ? "createdAt" : index === "by_approved" ? "approvedAt" : "deliveredAt"
    return await ctx.db
      .query("orders")
      .withIndex(index as "by_created", (q: any) => q.gte(field, from).lte(field, to))
      .paginate(paginationOpts)
  },
})

export const paymentsPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const res = await ctx.db.query("payments").paginate(paginationOpts)
    const page = await Promise.all(res.page.map(async (p) => {
      const o = await ctx.db.get(p.orderId)
      return { ...p, invoice: o ? invoiceLabel(o) : "", customer: o?.customerName ?? "", phone: o?.phone ?? "", source: o?.source ?? "" }
    }))
    return { ...res, page }
  },
})

export const stockRows = internalQuery({
  args: {},
  handler: async (ctx) => {
    const variants = await ctx.db.query("variants").collect()
    const products = new Map((await ctx.db.query("products").collect()).map((p) => [p._id as string, p]))
    const stock = await ctx.db.query("stock").collect()
    const locs = await ctx.db.query("locations").collect()
    return variants.map((vr) => {
      const rows = stock.filter((s) => s.variantId === vr._id)
      const by = (b: keyof Doc<"stock">) => rows.reduce((s, r) => s + ((r[b] as number) ?? 0), 0)
      const perLoc = Object.fromEntries(locs.map((l) => [l.name, rows.find((r) => r.locationId === l._id)?.available ?? 0]))
      return {
        SKU: vr.sku, Product: products.get(vr.productId)?.name ?? "", Variant: vr.title,
        ...perLoc,
        Available: by("available"), Processing: by("processing"), "In transit": by("inTransit"), Returning: by("returning"),
        Damaged: by("damaged"), Wastage: by("wastage"), Expired: by("expired"),
        "Stock value": by("available") * vr.price, "Purchase cost": by("available") * vr.purchasePrice,
      }
    })
  },
})

export const saveResult = internalMutation({
  args: { id: v.id("reports"), status: v.string(), columns: v.optional(v.array(v.string())), rows: v.optional(v.any()), error: v.optional(v.string()) },
  handler: async (ctx, { id, ...rest }) => ctx.db.patch(id, rest),
})

export function build(type: string, orders: Doc<"orders">[], _from: number, _to: number, source?: string) {
  const live = orders.filter((o) => !o.deletedAt && (!source || o.source === source))
  const rows: Record<string, any>[] = []
  const add = (m: Map<string, any>, k: string, init: () => any) => { if (!m.has(k)) m.set(k, init()); return m.get(k) }

  if (type.startsWith("sales_")) {
    const field = type === "sales_creation" ? "createdAt" : type === "sales_approved" ? "approvedAt" : "deliveredAt"
    const m = new Map<string, any>()
    for (const o of live) {
      const r = add(m, day((o as any)[field]), () => ({ Date: day((o as any)[field]), Orders: 0, Items: 0, "Sales amount": 0, Discount: 0, "Delivery fee": 0, Paid: 0, Due: 0, Delivered: 0, Returned: 0, Cancelled: 0 }))
      r.Orders++; r.Items += o.itemCount ?? o.items.reduce((s, i) => s + i.qty, 0)
      r["Sales amount"] += o.total; r.Discount += o.discount + o.items.reduce((s, i) => s + i.discount, 0)
      r["Delivery fee"] += o.deliveryFee; r.Paid += o.paidAmount; r.Due += o.due
      if (o.status.startsWith("delivered")) r.Delivered++
      if (["returned", "pending_returned", "damaged"].includes(o.status)) r.Returned++
      if (o.status === "cancelled") r.Cancelled++
    }
    rows.push(...[...m.values()].sort((a, b) => a.Date.localeCompare(b.Date)))
  } else if (type.startsWith("product_")) {
    const m = new Map<string, any>()
    for (const o of live) {
      if (type === "product_creation" && o.status === "cancelled") continue
      for (const i of o.items) {
        const r = add(m, baseName(i.name), () => ({ "Base product": baseName(i.name), Orders: new Set<string>(), Qty: 0, "Sales amount": 0, Discount: 0, Sizes: new Map<string, number>() }))
        r.Orders.add(o._id); r.Qty += i.qty; r["Sales amount"] += i.price * i.qty - i.discount; r.Discount += i.discount
        r.Sizes.set(i.attrs ?? "-", (r.Sizes.get(i.attrs ?? "-") ?? 0) + i.qty)
      }
    }
    rows.push(...[...m.values()].map((r) => ({
      "Base product": r["Base product"], Orders: r.Orders.size, Qty: r.Qty, "Sales amount": r["Sales amount"], Discount: r.Discount,
      "By size": [...r.Sizes.entries()].sort().map(([k, n]: [string, number]) => `${k}: ${n}`).join(", "),
    })).sort((a, b) => b.Qty - a.Qty))
  } else if (type === "daily_product_source_status") {
    const m = new Map<string, any>()
    for (const o of live) {
      for (const i of o.items) {
        const k = `${day(o.createdAt)}|${i.sku}|${o.source}|${o.status}`
        const r = add(m, k, () => ({ Date: day(o.createdAt), SKU: i.sku, Product: `${i.name}${i.attrs ? ` - ${i.attrs}` : ""}`, Source: o.source, Status: STATUS_LABEL[o.status as OrderStatus], Qty: 0, Amount: 0 }))
        r.Qty += i.qty; r.Amount += i.price * i.qty - i.discount
      }
    }
    rows.push(...[...m.values()].sort((a, b) => a.Date.localeCompare(b.Date) || a.SKU.localeCompare(b.SKU)))
  } else if (type === "paid_due") {
    for (const o of live.sort((a, b) => a.createdAt - b.createdAt)) {
      rows.push({
        Invoice: invoiceLabel(o), Date: day(o.createdAt), Customer: o.customerName, Phone: o.phone, Status: STATUS_LABEL[o.status as OrderStatus],
        Total: o.total, Paid: o.paidAmount, Due: o.due, "Payment method": o.paymentMethod ?? "", Courier: o.deliveryPartnerName ?? "", Consignment: o.consignmentId ?? "",
      })
    }
  } else if (type === "attribution") {
    const m = new Map<string, any>()
    for (const o of live) {
      const origin = o.origin || (o.source === "Website" ? "Direct / unknown" : o.source)
      const k = `${origin}|${o.campaignId ?? ""}`
      const r = add(m, k, () => ({ Origin: origin, Campaign: o.campaignId ?? "", Orders: 0, "Order value": 0, Delivered: 0, "Delivered value": 0, Returned: 0, Cancelled: 0 }))
      r.Orders++; r["Order value"] += o.total
      if (o.status.startsWith("delivered")) { r.Delivered++; r["Delivered value"] += o.total }
      if (["returned", "pending_returned", "damaged"].includes(o.status)) r.Returned++
      if (o.status === "cancelled") r.Cancelled++
    }
    rows.push(...[...m.values()].map((r) => ({ ...r, "Delivery rate %": r.Delivered + r.Returned ? Math.round((r.Delivered / (r.Delivered + r.Returned)) * 100) : "" })).sort((a, b) => b.Orders - a.Orders))
  } else if (type === "csat_trend") {
    // One row per day the CALL happened (not per day the order was placed) — a feedback or return call made
    // today about an older order still shows up as today's CSAT signal, which is what "is this trending down
    // this week" actually needs.
    const m = new Map<string, any>()
    const row = (d: string) => add(m, d, () => ({
      Date: d, "Feedback calls": 0,
      "Happy — no issues": 0, "Happy — minor issue": 0,
      "Unhappy — product issue": 0, "Unhappy — delivery issue": 0, "Unhappy — other": 0,
      "Feedback — could not reach": 0, "Feedback — declined": 0,
      "Return calls": 0, "Return — at fault": 0,
      "Recovery calls": 0, Recovered: 0,
    }))
    for (const o of live) {
      const csat = (o as any).csat as { outcome: string; at: number } | undefined
      if (csat) {
        const r = row(day(csat.at))
        r["Feedback calls"]++
        if (csat.outcome === "Could not reach") r["Feedback — could not reach"]++
        else if (csat.outcome === "Declined to answer") r["Feedback — declined"]++
        else if (csat.outcome in r) r[csat.outcome]++
      }
      const rc = (o as any).returnCsat as { outcome: string; at: number } | undefined
      if (rc) {
        const r = row(day(rc.at))
        r["Return calls"]++
        if (RETURN_AT_FAULT_REASONS.includes(rc.outcome)) r["Return — at fault"]++
      }
      const rec = (o as any).recovery as { outcome: string; at: number } | undefined
      if (rec) {
        const r = row(day(rec.at))
        r["Recovery calls"]++
        if (rec.outcome === "Recovered — placed a new order") r.Recovered++
      }
    }
    rows.push(...[...m.values()].map((r) => {
      const answered = r["Feedback calls"] - r["Feedback — could not reach"] - r["Feedback — declined"]
      const unhappy = r["Unhappy — product issue"] + r["Unhappy — delivery issue"] + r["Unhappy — other"]
      return { ...r, "Unhappy %": answered > 0 ? Math.round((unhappy / answered) * 100) : "", "Win-back %": r["Recovery calls"] > 0 ? Math.round((r.Recovered / r["Recovery calls"]) * 100) : "" }
    }).sort((a, b) => a.Date.localeCompare(b.Date)))
  } else if (type === "return_reasons") {
    // Which reason actually keeps coming back, confirmed by the return CALL (not just the category picked when
    // the return was first raised) — and for the ones that are BlackBole's own fault, did the recovery call
    // actually win the customer back.
    const m = new Map<string, any>()
    let totalCalls = 0
    for (const o of live) {
      const rc = (o as any).returnCsat as { outcome: string } | undefined
      if (!rc) continue
      totalCalls++
      const atFault = RETURN_AT_FAULT_REASONS.includes(rc.outcome)
      const r = add(m, rc.outcome, () => ({ Reason: rc.outcome, "At fault": atFault ? "Yes" : "No", Calls: 0, "Recovery attempted": 0, Recovered: 0 }))
      r.Calls++
      const rec = (o as any).recovery as { outcome: string } | undefined
      if (rec) {
        r["Recovery attempted"]++
        if (rec.outcome === "Recovered — placed a new order") r.Recovered++
      }
    }
    rows.push(...[...m.values()].map((r) => ({
      ...r,
      "% of return calls": totalCalls ? Math.round((r.Calls / totalCalls) * 100) : 0,
      "Win-back %": r["Recovery attempted"] ? Math.round((r.Recovered / r["Recovery attempted"]) * 100) : "",
    })).sort((a, b) => b.Calls - a.Calls))
  } else if (type === "csat_by_agent") {
    // Same calls, but by who made them — so a lead can see whose feedback calls are actually catching unhappy
    // customers (vs. rubber-stamping "Happy") and whose recovery calls are actually winning people back.
    const m = new Map<string, any>()
    const agentRow = (name: string) => add(m, name, () => ({ Agent: name, "Feedback calls": 0, Happy: 0, Unhappy: 0, "Could not reach": 0, "Return calls": 0, "Recovery calls": 0, Recovered: 0 }))
    for (const o of live) {
      const csat = (o as any).csat as { outcome: string; byName: string } | undefined
      if (csat) {
        const r = agentRow(csat.byName)
        r["Feedback calls"]++
        if (csat.outcome.startsWith("Happy")) r.Happy++
        else if (csat.outcome.startsWith("Unhappy")) r.Unhappy++
        else if (csat.outcome === "Could not reach") r["Could not reach"]++
      }
      const rc = (o as any).returnCsat as { byName: string } | undefined
      if (rc) agentRow(rc.byName)["Return calls"]++
      const rec = (o as any).recovery as { outcome: string; byName: string } | undefined
      if (rec) {
        const r = agentRow(rec.byName)
        r["Recovery calls"]++
        if (rec.outcome === "Recovered — placed a new order") r.Recovered++
      }
    }
    rows.push(...[...m.values()].map((r) => {
      const answered = r["Feedback calls"] - r["Could not reach"]
      return { ...r, "Happy %": answered > 0 ? Math.round((r.Happy / answered) * 100) : "", "Win-back %": r["Recovery calls"] > 0 ? Math.round((r.Recovered / r["Recovery calls"]) * 100) : "" }
    }).sort((a, b) => b["Feedback calls"] + b["Return calls"] - (a["Feedback calls"] + a["Return calls"])))
  }
  return rows
}

export const generate = internalAction({
  args: { id: v.id("reports"), type: v.string(), from: v.number(), to: v.number(), source: v.optional(v.string()) },
  handler: async (ctx, { id, type, from, to, source }) => {
    try {
      const def = REPORT_TYPES.find((r) => r.key === type)
      if (!def) throw new ConvexError("Unknown report type")
      let rows: Record<string, any>[] = []
      if (type === "stock_summary") {
        rows = await ctx.runQuery(internal.reports.stockRows, {})
      } else if (type === "payments") {
        let cursor: string | null = null
        do {
          const res: any = await ctx.runQuery(internal.reports.paymentsPage, { paginationOpts: { numItems: 500, cursor } })
          for (const p of res.page) {
            if (p.at < from || p.at > to) continue
            rows.push({ Date: day(p.at), Invoice: p.invoice, Customer: p.customer, Phone: p.phone, Source: p.source, Method: p.method, Amount: p.amount, Reference: p.reference ?? "", "Entered by": p.byName })
          }
          cursor = res.isDone ? null : res.continueCursor
        } while (cursor)
        rows.sort((a, b) => a.Date.localeCompare(b.Date))
      } else {
        const orders: Doc<"orders">[] = []
        let cursor: string | null = null
        do {
          const res: any = await ctx.runQuery(internal.reports.page, { index: def.index, from, to, paginationOpts: { numItems: 300, cursor } })
          orders.push(...res.page)
          cursor = res.isDone ? null : res.continueCursor
        } while (cursor)
        rows = build(type, orders, from, to, source)
      }
      const columns = rows.length ? Object.keys(rows[0]) : []
      await ctx.runMutation(internal.reports.saveResult, { id, status: "ready", columns, rows: rows.slice(0, 20000) })
    } catch (e) {
      await ctx.runMutation(internal.reports.saveResult, { id, status: "failed", error: e instanceof Error ? e.message : String(e) })
    }
  },
})

export const create = mutation({
  args: { type: v.string(), from: v.number(), to: v.number(), source: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const me = await requirePerm(ctx, "reports.view")
    const code = await nextCounter(ctx, "report", 1)
    const id = await ctx.db.insert("reports", { code, type: a.type, params: { from: a.from, to: a.to, source: a.source }, status: "running", createdBy: me.staff.name, createdAt: Date.now() })
    await ctx.scheduler.runAfter(0, internal.reports.generate, { id, ...a })
    return id
  },
})

export const list = query({
  args: {},
  handler: async (ctx) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const rows = await ctx.db.query("reports").withIndex("by_created").order("desc").take(100)
    return rows.map(({ rows: _r, ...rest }) => ({ ...rest, label: REPORT_TYPES.find((t) => t.key === rest.type)?.label ?? rest.type, rowCount: Array.isArray(_r) ? _r.length : 0 }))
  },
})

export const get = query({
  args: { id: v.id("reports") },
  handler: async (ctx, { id }) => {
    const s = await currentStaff(ctx)
    if (!s) return null
    const r = await ctx.db.get(id)
    return r ? { ...r, label: REPORT_TYPES.find((t) => t.key === r.type)?.label ?? r.type } : null
  },
})

export const types = query({ args: {}, handler: async () => REPORT_TYPES.map((t) => ({ key: t.key, label: t.label })) })
