import { ConvexError } from "convex/values"
import { getAuthUserId } from "@convex-dev/auth/server"
import type { MutationCtx, QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { internal } from "./_generated/api"
import { STATUS_BUCKET, STATUS_EVENT, STATUS_LABEL, hasPerm, type Bucket, type OrderStatus } from "./rules"

export type StaffCtx = { staff: Doc<"staff">; perms: string[] }

export async function currentStaff(ctx: QueryCtx): Promise<StaffCtx | null> {
  const userId = await getAuthUserId(ctx)
  if (!userId) return null
  const staff = await ctx.db
    .query("staff")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique()
  if (!staff || !staff.active) return null
  const role = await ctx.db.get(staff.roleId)
  return { staff, perms: effectivePerms(role?.permissions ?? [], staff) }
}

/** Role permissions, plus this person's extra switches, minus the ones switched off. Super Admin ("*") stays full. */
export function effectivePerms(rolePerms: string[], staff: { extraPerms?: string[]; deniedPerms?: string[] }) {
  if (rolePerms.includes("*")) return ["*"]
  const set = new Set([...rolePerms, ...(staff.extraPerms ?? [])])
  for (const d of staff.deniedPerms ?? []) set.delete(d)
  return [...set]
}


/** For mutations/queries that must have a permission. Throws a readable error. */
export async function requirePerm(ctx: QueryCtx, perm?: string): Promise<StaffCtx> {
  const s = await currentStaff(ctx)
  if (!s) throw new ConvexError("You are not signed in or your access was removed.")
  if (perm && !hasPerm(s.perms, perm)) throw new ConvexError("You don't have permission for this action.")
  return s
}

export async function nextCounter(ctx: MutationCtx, name: string, start = 1): Promise<number> {
  const row = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique()
  if (!row) {
    await ctx.db.insert("counters", { name, value: start })
    return start
  }
  const value = row.value + 1
  await ctx.db.patch(row._id, { value })
  return value
}

export async function setCounter(ctx: MutationCtx, name: string, value: number) {
  const row = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique()
  if (row) await ctx.db.patch(row._id, { value })
  else await ctx.db.insert("counters", { name, value })
}

export async function getSetting<T = any>(ctx: QueryCtx, key: string): Promise<T | undefined> {
  const row = await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", key)).unique()
  return row?.value as T | undefined
}

/** When orders are sent to Pathao: "in_transit" (default, like Nuport), "ready_to_ship", or "manual" (only by button). */
export async function pathaoBookAt(ctx: QueryCtx): Promise<"in_transit" | "ready_to_ship" | "manual"> {
  const v = await getSetting<string>(ctx, "pathaoBookAt")
  if (v === "in_transit" || v === "ready_to_ship" || v === "manual") return v
  return (await getSetting<boolean>(ctx, "pathaoAutoBook")) === false ? "manual" : "in_transit"
}

export async function setSetting(ctx: MutationCtx, key: string, value: any) {
  const row = await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", key)).unique()
  if (row) await ctx.db.patch(row._id, { value })
  else await ctx.db.insert("settings", { key, value })
}

export async function getStockRow(ctx: MutationCtx, variantId: Id<"variants">, locationId: Id<"locations">) {
  const row = await ctx.db
    .query("stock")
    .withIndex("by_variant_location", (q) => q.eq("variantId", variantId).eq("locationId", locationId))
    .unique()
  if (row) return row
  const id = await ctx.db.insert("stock", {
    variantId, locationId, available: 0, processing: 0, inTransit: 0, returning: 0, damaged: 0, wastage: 0, expired: 0,
  })
  return (await ctx.db.get(id))!
}

export type StockBucket = Bucket | "wastage" | "expired"

/** Add `change` to one stock bucket and write a stock log. "sold" is outside stock. */
export async function bumpStock(
  ctx: MutationCtx,
  args: {
    variantId: Id<"variants">
    locationId: Id<"locations">
    bucket: StockBucket
    change: number
    reason: string
    byName: string
    orderId?: Id<"orders">
    receiptId?: Id<"receipts">
    note?: string
  },
) {
  if (args.bucket === "sold" || args.change === 0) return
  const row = await getStockRow(ctx, args.variantId, args.locationId)
  const current = ((row as any)[args.bucket] as number | undefined) ?? 0
  await ctx.db.patch(row._id, { [args.bucket]: current + args.change })
  await ctx.db.insert("stockLogs", {
    variantId: args.variantId,
    locationId: args.locationId,
    bucket: args.bucket,
    change: args.change,
    reason: args.reason,
    orderId: args.orderId,
    receiptId: args.receiptId,
    note: args.note,
    byName: args.byName,
    at: Date.now(),
  })
}

export const invoiceLabel = (o: { invoiceNo: number; invoiceCode?: string }) => o.invoiceCode ?? `BB-${o.invoiceNo}`

/** Move an order's units between stock buckets when its status changes. */
export async function moveOrderStock(
  ctx: MutationCtx,
  order: Doc<"orders">,
  from: OrderStatus,
  to: OrderStatus,
  byName: string,
) {
  const a = STATUS_BUCKET[from]
  const b = STATUS_BUCKET[to]
  if (a === b) return
  const reason = `Order ${invoiceLabel(order)}: ${STATUS_LABEL[from]} → ${STATUS_LABEL[to]}`
  for (const item of order.items) {
    if (!item.variantId) continue
    await bumpStock(ctx, { variantId: item.variantId, locationId: order.locationId, bucket: a, change: -item.qty, reason, byName, orderId: order._id })
    await bumpStock(ctx, { variantId: item.variantId, locationId: order.locationId, bucket: b, change: item.qty, reason, byName, orderId: order._id })
  }
}

export async function logOrder(
  ctx: MutationCtx,
  orderId: Id<"orders">,
  text: string,
  byName: string,
  type: "log" | "note" | "call" | "payment" = "log",
  outcome?: string,
) {
  await ctx.db.insert("orderEvents", { orderId, type, text, outcome, byName, at: Date.now() })
}

export async function defaultLocation(ctx: QueryCtx) {
  const all = await ctx.db.query("locations").collect()
  return all.find((l) => l.isDefault && l.active) ?? all.find((l) => l.active) ?? null
}

/** Default delivery partner for a warehouse (first active Pathao partner linked to it). */
export async function defaultPartner(ctx: QueryCtx, locationId: Id<"locations">) {
  const loc = await ctx.db.get(locationId)
  if (loc?.noCourier) return null // exchange warehouse: no courier, never Pathao
  const all = (await ctx.db.query("deliveryPartners").collect()).filter((p) => p.active && !p.deletedAt)
  return (
    all.find((p) => p.locationId === locationId && p.provider === "pathao" && !p.isExchange) ??
    all.find((p) => p.locationId === locationId) ??
    all.find((p) => p.provider === "pathao" && !p.isExchange) ??
    null
  )
}

export async function notify(ctx: MutationCtx, title: string, body: string, orderId?: Id<"orders">, kind = "info") {
  await ctx.db.insert("notifications", { kind, title, body, orderId, readBy: [], at: Date.now() })
}

/** Fire outgoing integrations for an order status: webhook + customer SMS. */
export async function emitOrderEvent(ctx: MutationCtx, orderId: Id<"orders">, status: OrderStatus) {
  const hook = await getSetting<any>(ctx, "webhook")
  if (hook?.url && (hook.events ?? []).includes(STATUS_EVENT[status])) {
    await ctx.scheduler.runAfter(0, internal.outbound.sendOrderWebhook, { orderId, event: STATUS_EVENT[status] })
  }
  const sms = await getSetting<any>(ctx, "sms")
  if (sms?.enabled && (sms.statuses ?? []).includes(status)) {
    await ctx.scheduler.runAfter(0, internal.outbound.sendOrderSms, { orderId, status })
  }
}

/** Purchase cost of an order's items from current variant costs. */
export async function computePurchaseCost(ctx: QueryCtx, items: Doc<"orders">["items"]) {
  let total = 0
  for (const i of items) {
    if (!i.variantId) continue
    const vr = await ctx.db.get(i.variantId)
    total += (vr?.purchasePrice ?? 0) * i.qty
  }
  return total
}

export function bdNow() {
  return new Date(Date.now() + 6 * 3600000)
}
