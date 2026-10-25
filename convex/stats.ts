// Daily scoreboard for the dashboard.
// Every change to an order adds/removes its numbers on the scoreboard row of the day the order was made,
// so the dashboard reads a few small rows instead of thousands of orders.
import { v } from "convex/values"
import { internalMutation, internalQuery } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import type { GenericDatabaseWriter, GenericDatabaseReader } from "convex/server"
import type { DataModel } from "./_generated/dataModel"
import { internal } from "./_generated/api"

const BD = 6 * 3600000 // Asia/Dhaka
const DAY = 86400000
export const bdDay = (t: number) => new Date(t + BD).toISOString().slice(0, 10)
export const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) - BD

const DELIVERED = ["delivered_due", "delivered_paid"]
const RETURNED = ["pending_returned", "returned", "damaged"]
const r2 = (n: number) => Math.round(n * 100) / 100

type Item = { k: string; name: string; q: number; v: number }
type Contrib = { day: string; status: string; total: number; due: number; source: string; qty: number; items: Item[] }
export type DayRow = { day: string; st: { s: string; n: number; v: number }[]; src: { s: string; c: number; v: number }[]; it: Item[]; due: number; q: number }

/** What one order adds to its day's scoreboard (null when it doesn't count: deleted). */
export function contrib(o: Doc<"orders"> | null): Contrib | null {
  if (!o || o.deletedAt) return null
  const live = o.status !== "cancelled"
  return {
    day: bdDay(o.createdAt), status: o.status, total: o.total, due: o.status === "delivered_due" ? o.due : 0, source: o.source,
    qty: live ? (o.itemCount ?? o.items.reduce((t, i) => t + i.qty, 0)) : 0,
    items: live ? o.items.map((i) => ({ k: i.sku, name: `${i.name}${i.attrs ? ` - ${i.attrs}` : ""}`, q: i.qty, v: i.price * i.qty - i.discount })) : [],
  }
}

export const emptyDay = (day: string): DayRow => ({ day, st: [], src: [], it: [], due: 0, q: 0 })

export function addTo(row: DayRow, c: Contrib, sign: 1 | -1) {
  const st = row.st.find((x) => x.s === c.status) ?? (row.st.push({ s: c.status, n: 0, v: 0 }), row.st[row.st.length - 1])
  st.n += sign; st.v = r2(st.v + sign * c.total)
  row.due = r2(row.due + sign * c.due)
  if (c.status !== "cancelled") {
    const src = row.src.find((x) => x.s === c.source) ?? (row.src.push({ s: c.source, c: 0, v: 0 }), row.src[row.src.length - 1])
    src.c += sign; src.v = r2(src.v + sign * c.total)
    row.q += sign * c.qty
    for (const i of c.items) {
      const it = row.it.find((x) => x.k === i.k) ?? (row.it.push({ k: i.k, name: i.name, q: 0, v: 0 }), row.it[row.it.length - 1])
      it.q += sign * i.q; it.v = r2(it.v + sign * i.v)
      if (sign > 0) it.name = i.name
    }
  }
  row.st = row.st.filter((x) => x.n !== 0 || Math.abs(x.v) > 0.01)
  row.src = row.src.filter((x) => x.c !== 0 || Math.abs(x.v) > 0.01)
  row.it = row.it.filter((x) => x.q !== 0 || Math.abs(x.v) > 0.01)
}

async function loadDay(db: GenericDatabaseReader<DataModel>, day: string) {
  return await db.query("dayStats").withIndex("by_day", (q) => q.eq("day", day)).unique()
}

async function saveDay(db: GenericDatabaseWriter<DataModel>, existing: Doc<"dayStats"> | null, row: DayRow) {
  const data = { day: row.day, st: row.st, src: row.src, it: row.it, due: row.due, q: row.q }
  if (existing) await db.replace(existing._id, data)
  else await db.insert("dayStats", data)
}

/** Trigger: runs inside the same save as the order change, so the scoreboard can never drift from the orders. */
export async function orderStatsTrigger(ctx: { innerDb: GenericDatabaseWriter<DataModel> }, change: { oldDoc: Doc<"orders"> | null; newDoc: Doc<"orders"> | null }) {
  const a = contrib(change.oldDoc)
  const b = contrib(change.newDoc)
  if (JSON.stringify(a) === JSON.stringify(b)) return // notes, calls, courier fields… don't touch the numbers
  const days = new Set([a?.day, b?.day].filter(Boolean) as string[])
  for (const day of days) {
    const doc = await loadDay(ctx.innerDb, day)
    const row: DayRow = doc ? { day, st: doc.st, src: doc.src, it: doc.it, due: doc.due, q: doc.q } : emptyDay(day)
    if (a?.day === day) addTo(row, a, -1)
    if (b?.day === day) addTo(row, b, 1)
    await saveDay(ctx.innerDb, doc, row)
  }
}

/** Work a day out from scratch from its orders (used to fill the scoreboard the first time). */
async function rebuildDay(db: GenericDatabaseWriter<DataModel>, day: string) {
  const from = dayStart(day)
  const orders = await db.query("orders").withIndex("by_created", (q) => q.gte("createdAt", from).lt("createdAt", from + DAY)).collect()
  const row = emptyDay(day)
  for (const o of orders) { const c = contrib(o); if (c) addTo(row, c, 1) }
  const doc = await loadDay(db, day)
  if (orders.length || doc) await saveDay(db, doc, row)
  return orders.length
}

/** One-time fill: day by day from the first order to today, in small steps so nothing slows down. */
export const backfill = internalMutation({
  args: { day: v.optional(v.string()) },
  handler: async (ctx, { day }) => {
    let d = day
    if (!d) {
      const first = await ctx.db.query("orders").withIndex("by_created").first()
      if (!first) return
      d = bdDay(first.createdAt)
    }
    const today = bdDay(Date.now())
    let read = 0
    let steps = 0
    while (d <= today && read < 500 && steps < 120) {
      read += await rebuildDay(ctx.db, d)
      d = bdDay(dayStart(d) + DAY + 3600000)
      steps++
    }
    if (d <= today) await ctx.scheduler.runAfter(0, internal.stats.backfill, { day: d })
    else {
      const row = await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "statsReady")).unique()
      if (row) await ctx.db.patch(row._id, { value: true })
      else await ctx.db.insert("settings", { key: "statsReady", value: true })
    }
  },
})

export const ready = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "statsReady")).unique())?.value === true,
})

export const days = internalQuery({
  args: { fromDay: v.string(), toDay: v.string() },
  handler: async (ctx, { fromDay, toDay }) => {
    const rows = await ctx.db.query("dayStats").withIndex("by_day", (q) => q.gte("day", fromDay).lte("day", toDay)).collect()
    return rows.map((r) => ({ day: r.day, st: r.st, src: r.src, it: r.it, due: r.due, q: r.q })) as DayRow[]
  },
})

/** Same shape as the old dashboard numbers, worked out from scoreboard rows. */
export function statsFromDays(rows: DayRow[], from: number, to: number) {
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const daily: { day: string; orders: number; sales: number; delivered: number; returned: number; cancelled: number; open: number }[] = []
  for (let t = from; t <= to; t += DAY) {
    const key = bdDay(t)
    const r = byDay.get(key)
    const d = { day: key, orders: 0, sales: 0, delivered: 0, returned: 0, cancelled: 0, open: 0 }
    for (const s of r?.st ?? []) {
      if (s.s === "cancelled") { d.cancelled += s.n; continue }
      d.orders += s.n; d.sales = r2(d.sales + s.v)
      if (DELIVERED.includes(s.s)) d.delivered += s.n
      else if (RETURNED.includes(s.s)) d.returned += s.n
      else d.open += s.n
    }
    daily.push(d)
  }
  const inRange = rows.filter((r) => r.day >= bdDay(from) && r.day <= bdDay(to))
  const byStatus: Record<string, number> = {}
  const statusValue: Record<string, number> = {}
  const bySource = new Map<string, { count: number; value: number }>()
  const items = new Map<string, { sku: string; name: string; qty: number; value: number }>()
  let due = 0
  for (const r of inRange) {
    due += r.due
    for (const s of r.st) { byStatus[s.s] = (byStatus[s.s] ?? 0) + s.n; statusValue[s.s] = r2((statusValue[s.s] ?? 0) + s.v) }
    for (const s of r.src) { const x = bySource.get(s.s) ?? { count: 0, value: 0 }; x.count += s.c; x.value = r2(x.value + s.v); bySource.set(s.s, x) }
    for (const i of r.it) { const x = items.get(i.k) ?? { sku: i.k, name: i.name, qty: 0, value: 0 }; x.qty += i.q; x.value = r2(x.value + i.v); items.set(i.k, x) }
  }
  for (const k of Object.keys(byStatus)) if (byStatus[k] === 0) delete byStatus[k]
  const sum = (list: string[], m: Record<string, number>) => list.reduce((t, s) => t + (m[s] ?? 0), 0)
  const delivered = sum(DELIVERED, byStatus)
  const returned = sum(RETURNED, byStatus)
  const cancelled = byStatus.cancelled ?? 0
  const totalOrders = Object.entries(byStatus).filter(([s]) => s !== "cancelled").reduce((t, [, n]) => t + n, 0)
  const totalSales = r2(Object.entries(statusValue).filter(([s]) => s !== "cancelled").reduce((t, [, n]) => t + n, 0))
  return {
    returned, delivered,
    deliveredValue: r2(sum(DELIVERED, statusValue)),
    totalOrders, totalSales,
    avgOrder: totalOrders ? Math.round(totalSales / totalOrders) : 0,
    cancelled,
    deliveryRate: delivered + returned ? Math.round((delivered / (delivered + returned)) * 100) : null,
    dueCollect: r2(due),
    daily, byStatus,
    bySource: [...bySource.entries()].filter(([, x]) => x.count !== 0).map(([source, x]) => ({ source, ...x })).sort((a, b) => b.count - a.count),
    topItems: [...items.values()].filter((x) => x.qty !== 0).sort((a, b) => b.qty - a.qty).slice(0, 10),
  }
}
